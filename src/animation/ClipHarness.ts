import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { disposeObject3D } from '../utils/dispose';
import { ANKLE_BONE_PATTERN, HIPS_BONE_PATTERN, TOE_BONE_PATTERN, boneSide } from './rig-names';

/**
 * Headless rig for working out what a clip actually *is* — how fast it travels,
 * how much the hips bob, whether the feet leave the ground — without touching
 * the live character or needing anything rendered.
 *
 * The model is normalized to the same gameplay height the `Character`
 * constructor uses, so every number this reports is directly comparable with
 * runtime speeds and can be stored and replayed verbatim.
 */

export const TARGET_HEIGHT = 1.75;
const STRIDE_SAMPLES = 48;
/** Foot rise above its own resting low point that counts as airborne. */
const AIR_LIFT_FRACTION = 0.1;
/** Mean first-to-last rotation difference below which a clip reads as a cycle. */
const LOOP_ANGLE_DEGREES = 14;

export interface ClipMetrics {
  duration: number;
  /** Ground speed the clip was authored for, m/s at gameplay height. */
  groundSpeed: number | null;
  /** Vertical travel of the hips over the clip, in metres. */
  hipBob: number;
  /** Fraction of the clip with both feet off the ground. */
  airTime: number;
  /** Highest the lower foot gets above its resting height, in metres. */
  maxFootLift: number;
  /** True when the first and last pose match, as a locomotion cycle's do. */
  loops: boolean;
}

interface FootBone {
  bone: THREE.Object3D;
  isToe: boolean;
}

export { cloneSkinned };

export class ClipHarness {
  readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly feet: FootBone[] = [];
  private readonly hips: THREE.Object3D | null;

  /** Takes ownership of `model`; call `dispose()` when finished with it. */
  constructor(model: THREE.Object3D) {
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = TARGET_HEIGHT / Math.max(size.y, 0.01);
    model.scale.multiplyScalar(scale);
    bounds.setFromObject(model);
    model.position.y -= bounds.min.y;
    this.root.add(model);

    this.mixer = new THREE.AnimationMixer(model);
    this.collectBones(model);
    this.hips = this.findHips(model);
  }

  private collectBones(model: THREE.Object3D): void {
    const bySide = new Map<string, FootBone>();
    model.traverse((object) => {
      if (!(object as THREE.Bone).isBone) return;
      const isToe = TOE_BONE_PATTERN.test(object.name);
      const isAnkle = !isToe && ANKLE_BONE_PATTERN.test(object.name);
      if (!isToe && !isAnkle) return;
      const side = boneSide(object.name);
      if (!side) return;
      // Prefer the toe: it stays planted longest, so its backward travel is the
      // cleanest read of how far the body moves per step.
      const existing = bySide.get(side);
      if (!existing) bySide.set(side, { bone: object, isToe });
      else if (isToe && !existing.isToe) {
        existing.bone = object;
        existing.isToe = true;
      }
    });
    this.feet.push(...bySide.values());
  }

  private findHips(model: THREE.Object3D): THREE.Object3D | null {
    let best: THREE.Object3D | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    model.traverse((object) => {
      if (!(object as THREE.Bone).isBone) return;
      if (!HIPS_BONE_PATTERN.test(object.name)) return;
      let depth = 0;
      let current: THREE.Object3D | null = object.parent;
      while (current) {
        depth += 1;
        current = current.parent;
      }
      if (depth < bestDepth) {
        bestDepth = depth;
        best = object;
      }
    });
    return best;
  }

  /** True when the rig exposes enough named bones to measure anything useful. */
  get canMeasure(): boolean {
    return this.feet.length >= 2;
  }

  measure(clip: THREE.AnimationClip): ClipMetrics {
    const duration = clip.duration;
    const base: ClipMetrics = {
      duration,
      groundSpeed: null,
      hipBob: 0,
      airTime: 0,
      maxFootLift: 0,
      loops: clipLoops(clip),
    };
    if (!Number.isFinite(duration) || duration <= 0 || this.feet.length < 2) return base;

    const action = this.mixer.clipAction(clip);
    action.reset();
    action.enabled = true;
    action.timeScale = 1;
    action.setEffectiveWeight(1);
    action.play();

    const step = duration / STRIDE_SAMPLES;
    const scratch = new THREE.Vector3();
    const footSamples: Array<{ x: number; y: number; z: number }[]> = [];
    const hipsY: number[] = [];

    for (let i = 0; i <= STRIDE_SAMPLES; i += 1) {
      this.mixer.update(i === 0 ? 0 : step);
      this.root.updateMatrixWorld(true);
      footSamples.push(
        this.feet.map((foot) => {
          foot.bone.getWorldPosition(scratch);
          this.root.worldToLocal(scratch);
          return { x: scratch.x, y: scratch.y, z: scratch.z };
        }),
      );
      if (this.hips) {
        this.hips.getWorldPosition(scratch);
        this.root.worldToLocal(scratch);
        hipsY.push(scratch.y);
      }
    }

    action.stop();
    action.setEffectiveWeight(0);
    this.mixer.uncacheAction(clip);

    return {
      ...base,
      groundSpeed: measureGroundSpeed(footSamples, step),
      hipBob: hipsY.length > 0 ? Math.max(...hipsY) - Math.min(...hipsY) : 0,
      ...measureFootLift(footSamples),
    };
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
    disposeObject3D(this.root);
  }
}

/**
 * Ground speed from the planted foot's travel underneath the body.
 *
 * The direction of travel is derived rather than assumed. The original version
 * of this only counted movement along -Z, which silently returned nothing for a
 * clip authored facing any other way — and uploaded takes have no guaranteed
 * facing at all.
 */
function measureGroundSpeed(
  samples: Array<{ x: number; y: number; z: number }[]>,
  step: number,
): number | null {
  if (samples.length < 2 || step <= 0) return null;

  const deltas: Array<{ x: number; z: number }> = [];
  let previousPlanted = -1;
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    // The lower foot is the one carrying weight.
    const planted = current[0].y <= current[1].y ? 0 : 1;
    // Skip the frame weight transfers: the two feet are metres apart, so the
    // switch reads as a huge bogus displacement.
    if (planted === previousPlanted) {
      deltas.push({
        x: current[planted].x - previous[planted].x,
        z: current[planted].z - previous[planted].z,
      });
    }
    previousPlanted = planted;
  }
  if (deltas.length === 0) return null;

  let sumX = 0;
  let sumZ = 0;
  for (const delta of deltas) {
    sumX += delta.x;
    sumZ += delta.z;
  }
  const magnitude = Math.hypot(sumX, sumZ);
  if (magnitude < 1e-6) return 0;
  const dirX = sumX / magnitude;
  const dirZ = sumZ / magnitude;

  let travel = 0;
  for (const delta of deltas) {
    travel += Math.max(0, delta.x * dirX + delta.z * dirZ);
  }
  return travel / (deltas.length * step);
}

function measureFootLift(
  samples: Array<{ x: number; y: number; z: number }[]>,
): { airTime: number; maxFootLift: number } {
  if (samples.length === 0) return { airTime: 0, maxFootLift: 0 };
  const lower = samples.map((feet) => Math.min(feet[0].y, feet[1].y));
  const baseline = Math.min(...lower);
  const threshold = TARGET_HEIGHT * AIR_LIFT_FRACTION;
  let airborne = 0;
  let maxLift = 0;
  for (const y of lower) {
    const lift = y - baseline;
    maxLift = Math.max(maxLift, lift);
    if (lift > threshold) airborne += 1;
  }
  return { airTime: airborne / lower.length, maxFootLift: maxLift };
}

/**
 * Whether the clip's first and last pose match. Compared straight off the track
 * data rather than by sampling, so it needs no mixer and cannot be confused by
 * loop wrapping at the end of playback.
 */
function clipLoops(clip: THREE.AnimationClip): boolean {
  let total = 0;
  let count = 0;
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion')) continue;
    const values = track.values;
    const frames = Math.floor(values.length / 4);
    if (frames < 2) continue;
    const last = (frames - 1) * 4;
    const dot = Math.abs(
      values[0] * values[last] +
        values[1] * values[last + 1] +
        values[2] * values[last + 2] +
        values[3] * values[last + 3],
    );
    total += 2 * Math.acos(Math.min(1, dot));
    count += 1;
  }
  if (count === 0) return true;
  return THREE.MathUtils.radToDeg(total / count) < LOOP_ANGLE_DEGREES;
}
