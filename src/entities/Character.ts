import * as THREE from 'three';
import { createMintGltfLoader } from '../assets/gltf-runtime';
import { loadModelBytes, loadModelUrl, type LoadedModel } from '../assets/model-loading';
import {
  collectBoneNames,
  collectBones,
  fitClipToSkeleton,
  prepareUploadedClip,
  MIN_CLIP_BINDING,
  type RetargetTarget,
} from '../animation/clip-fit';
import {
  ANKLE_BONE_PATTERN,
  FOREARM_PATTERN,
  HIPS_BONE_PATTERN,
  LEFT_PATTERN,
  RIGHT_PATTERN,
  TOE_BONE_PATTERN,
  UPPER_ARM_PATTERN,
} from '../animation/rig-names';
import { disposeObject3D } from '../utils/dispose';
import type { AssetLibrary } from '../mint/library';
import type {
  CharacterClipRef,
  CharacterEntry,
  ClipRole,
  LibraryFileRef,
} from '../mint/registry';

export type { ClipRole };

/** Where the clip playing a role came from. */
export type ClipSource = 'own' | 'borrowed' | 'legacy';

export interface ClipDescription {
  role: ClipRole;
  clipName: string;
  duration: number;
  bindRate: number;
  unitScale: number;
  rootMotion: boolean;
  source: ClipSource;
}

const TARGET_HEIGHT = 1.75;
const FADE_SECONDS = 0.18;
// Fallbacks only. The ground speed each cycle was authored for is measured from
// the clip itself at load; guessing it is what made the feet skate.
const WALK_FALLBACK_SPEED = 1.4;
const RUN_FALLBACK_SPEED = 3.6;
const STRIDE_SAMPLES = 48;
const MIN_PLAUSIBLE_CLIP_SPEED = 0.35;
const MAX_PLAUSIBLE_CLIP_SPEED = 9;
/** How far playback may stray from the clip's authored cadence. */
const MIN_TIME_SCALE = 0.55;
const MAX_TIME_SCALE = 2.3;
const IDLE_FULL_BELOW = 0.15;
const WALK_FULL_AT = 0.9;
const RUN_BLEND_START = 2.4;
const RUN_FULL_AT = 4.2;
const WEIGHT_LAMBDA = 12;
// How far above the sole each kind of foot bone typically sits, in metres at
// the normalized character height.
const TOE_BONE_CLEARANCE = 0.03;
const ANKLE_BONE_CLEARANCE = 0.09;
const MAX_FOOT_CORRECTION = 0.25;
/**
 * How much of the arm's sideways spread to remove. Scaling rather than clamping
 * keeps the arm's lateral movement alive instead of freezing it at a limit.
 */
const DEFAULT_ARM_NARROWING = 0.55;
/** Spread below this is left alone — a naturally narrow arm needs no help. */
const ARM_SPREAD_FLOOR = 8;
const MAX_ARM_TUCK = 55;
/** Share of the upper-arm correction passed to the forearm so hands come in too. */
const FOREARM_TUCK_SHARE = 0.55;
// Smooth fades replacing hard cutoffs, so the correction can never step between
// frames as the arm swings through.
const FRONTAL_FADE_IN = 0.18;
const FRONTAL_FADE_OUT = 0.42;
const DOWNWARD_FADE = 0.25;
const CHARACTER_ENV_MAP_INTENSITY = 1;

/**
 * A rigged Mint character driven by a small locomotion blend tree: idle, walk,
 * and run play continuously with speed-driven weights and stride-synced
 * timeScale; jump is a one-shot overlay. Root origin is at the feet.
 */
export class Character {
  readonly root = new THREE.Group();
  readonly height: number;

  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<ClipRole, THREE.AnimationAction>();
  private readonly weights: Record<'idle' | 'walk' | 'run', number> = {
    idle: 1,
    walk: 0,
    run: 0,
  };
  private jumping = false;
  private locomotionSynced = false;
  private readonly borrowed: ClipRole[];
  private readonly rigged: boolean;
  /** Speeds already derived at import or from a clip's own root motion. */
  private readonly authoredSpeeds: Partial<Record<ClipRole, number>>;
  private readonly clipInfo: Partial<Record<ClipRole, ClipDescription>>;
  private reducedMotion = false;
  /** How far the posed feet had to be corrected off the bind-pose estimate. */
  readonly footCorrection: number;

  private readonly arms: ArmChain[] = [];
  private readonly feet: FootBone[] = [];
  private hips: THREE.Object3D | null = null;
  private readonly naturalSpeeds: Record<'walk' | 'run', number> = {
    walk: WALK_FALLBACK_SPEED,
    run: RUN_FALLBACK_SPEED,
  };
  private armNarrowing = DEFAULT_ARM_NARROWING;
  private lastArmSpread: ArmSpread = {
    leftBefore: 0,
    rightBefore: 0,
    leftAfter: 0,
    rightAfter: 0,
  };
  private readonly armDirection = new THREE.Vector3();
  private readonly armPivot = new THREE.Vector3();
  private readonly armElbow = new THREE.Vector3();
  private readonly rootQuaternion = new THREE.Quaternion();
  private readonly rootInverse = new THREE.Quaternion();
  private readonly parentWorld = new THREE.Quaternion();
  private readonly parentInverse = new THREE.Quaternion();
  private readonly tuckAxis = new THREE.Vector3();
  private readonly tuckDelta = new THREE.Quaternion();
  private readonly rebasedDelta = new THREE.Quaternion();

  private constructor(
    readonly entry: CharacterEntry,
    model: THREE.Group,
    clips: Partial<Record<ClipRole, THREE.AnimationClip>>,
    rig: {
      borrowed: ClipRole[];
      hasSkeleton: boolean;
      authoredSpeeds?: Partial<Record<ClipRole, number>>;
      clipInfo?: Partial<Record<ClipRole, ClipDescription>>;
    },
  ) {
    this.borrowed = rig.borrowed;
    this.rigged = rig.hasSkeleton;
    this.authoredSpeeds = rig.authoredSpeeds ?? {};
    this.clipInfo = rig.clipInfo ?? {};
    // Normalize every character to the same gameplay height and put the feet
    // at the root origin so swaps never change how the controller behaves.
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const rawHeight = Math.max(size.y, 0.01);
    const scale = TARGET_HEIGHT / rawHeight;
    model.scale.setScalar(scale);
    bounds.setFromObject(model);
    model.position.y -= bounds.min.y;
    model.position.x -= (bounds.min.x + bounds.max.x) / 2;
    model.position.z -= (bounds.min.z + bounds.max.z) / 2;

    this.height = TARGET_HEIGHT;
    this.root.name = `mint-character:${entry.key}`;
    this.root.add(model);

    const t = entry.transform;
    this.root.scale.multiply(new THREE.Vector3(...t.scale));

    this.mixer = new THREE.AnimationMixer(model);
    for (const [role, clip] of Object.entries(clips) as Array<[ClipRole, THREE.AnimationClip]>) {
      const action = this.mixer.clipAction(clip);
      if (role === 'jump') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.play();
        action.setEffectiveWeight(role === 'idle' ? 1 : 0);
      }
      this.actions.set(role, action);
    }

    this.footCorrection = this.alignPosedFeet(model);
    this.collectArmChains(model);
    this.collectFootBones(model);
    this.measureNaturalSpeeds();
    prepareMaterials(model);
  }

  private collectFootBones(model: THREE.Group): void {
    model.traverse((object) => {
      if (!(object as THREE.Bone).isBone) return;
      if (!this.hips && HIPS_BONE_PATTERN.test(object.name)) this.hips = object;
      if (!TOE_BONE_PATTERN.test(object.name) && !ANKLE_BONE_PATTERN.test(object.name)) return;
      const isLeft = LEFT_PATTERN.test(object.name);
      const isRight = RIGHT_PATTERN.test(object.name);
      if (!isLeft && !isRight) return;
      // Prefer the toe: it stays planted longest, so its backward travel is the
      // cleanest read of how far the body moves per step.
      const side: ArmSide = isLeft ? 'left' : 'right';
      const isToe = TOE_BONE_PATTERN.test(object.name);
      const existing = this.feet.find((foot) => foot.side === side);
      if (!existing) this.feet.push({ side, bone: object, isToe });
      else if (isToe && !existing.isToe) {
        existing.bone = object;
        existing.isToe = true;
      }
    });
  }

  /**
   * Works out the ground speed each locomotion clip was authored for, by
   * running the clip in isolation and watching how fast the planted foot
   * travels backwards underneath the body. Playback rate is then derived from
   * this, so a stride covers exactly the distance the controller moves and the
   * feet stop sliding.
   */
  private measureNaturalSpeeds(): void {
    for (const role of ['walk', 'run'] as const) {
      const action = this.actions.get(role);
      if (!action) continue;
      // A speed carried in from the import — or read off the clip's own root
      // motion — is a direct measurement of how far the clip travels, so it
      // beats inferring it from foot travel.
      const authored = this.authoredSpeeds[role];
      if (
        authored !== undefined &&
        Number.isFinite(authored) &&
        authored >= MIN_PLAUSIBLE_CLIP_SPEED &&
        authored <= MAX_PLAUSIBLE_CLIP_SPEED
      ) {
        this.naturalSpeeds[role] = authored;
        continue;
      }
      if (this.feet.length < 2) continue;
      const measured = this.measureClipSpeed(action);
      if (measured !== null) this.naturalSpeeds[role] = measured;
    }
  }

  private measureClipSpeed(action: THREE.AnimationAction): number | null {
    const duration = action.getClip().duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;

    // Isolate the clip so nothing else contributes to the sampled pose.
    const saved = [...this.actions.values()].map((other) => ({
      action: other,
      weight: other.getEffectiveWeight(),
      timeScale: other.timeScale,
      time: other.time,
      enabled: other.enabled,
    }));
    for (const entry of saved) entry.action.setEffectiveWeight(0);
    action.reset();
    action.enabled = true;
    action.timeScale = 1;
    action.setEffectiveWeight(1);
    action.play();

    const step = duration / STRIDE_SAMPLES;
    const current = new THREE.Vector3();
    let previous: Array<{ y: number; z: number }> | null = null;
    let total = 0;
    let samples = 0;

    for (let i = 0; i <= STRIDE_SAMPLES; i += 1) {
      this.mixer.update(i === 0 ? 0 : step);
      this.root.updateMatrixWorld(true);
      const positions = this.feet.map((foot) => {
        foot.bone.getWorldPosition(current);
        this.root.worldToLocal(current);
        return { y: current.y, z: current.z };
      });
      if (previous) {
        // The lower foot is the one carrying weight; its backward travel is the
        // distance the body covers.
        const index = positions[0].y <= positions[1].y ? 0 : 1;
        const travel = previous[index].z - positions[index].z;
        if (travel > 0) {
          total += travel / step;
          samples += 1;
        }
      }
      previous = positions;
    }

    for (const entry of saved) {
      entry.action.enabled = entry.enabled;
      entry.action.timeScale = entry.timeScale;
      entry.action.time = entry.time;
      entry.action.setEffectiveWeight(entry.weight);
    }

    if (samples === 0) return null;
    const speed = total / samples;
    if (speed < MIN_PLAUSIBLE_CLIP_SPEED || speed > MAX_PLAUSIBLE_CLIP_SPEED) return null;
    return speed;
  }

  /**
   * Finds each upper-arm bone plus the elbow beneath it. The elbow gives the
   * arm's actual direction, which is what the spread is measured from.
   */
  private collectArmChains(model: THREE.Group): void {
    const bones: THREE.Bone[] = [];
    model.traverse((object) => {
      if ((object as THREE.Bone).isBone) bones.push(object as THREE.Bone);
    });

    for (const bone of bones) {
      if (FOREARM_PATTERN.test(bone.name)) continue;
      if (!UPPER_ARM_PATTERN.test(bone.name)) continue;
      const elbow = findElbow(bone);
      if (!elbow) continue;
      const isLeft = LEFT_PATTERN.test(bone.name);
      const isRight = RIGHT_PATTERN.test(bone.name);
      if (!isLeft && !isRight) continue;
      const side: ArmSide = isLeft ? 'left' : 'right';
      // Several bones can match on a chain (clavicle, shoulder, arm); keep the
      // one closest to the elbow so the correction pivots at the shoulder.
      const existing = this.arms.find((arm) => arm.side === side);
      if (!existing) {
        this.arms.push({ side, bone, elbow });
      } else if (bone.parent === existing.bone || isDescendantOf(bone, existing.bone)) {
        existing.bone = bone;
        existing.elbow = elbow;
      }
    }
  }

  /**
   * Box3 measures a skinned mesh in its bind pose, so a character whose idle
   * stance differs from the T-pose lands slightly above or below the ground.
   * Re-measure from the posed foot bones once the idle clip is applied.
   */
  private alignPosedFeet(model: THREE.Group): number {
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);

    let lowestToe = Number.POSITIVE_INFINITY;
    let lowestAnkle = Number.POSITIVE_INFINITY;
    const local = new THREE.Vector3();
    model.traverse((object) => {
      if (!(object as THREE.Bone).isBone) return;
      const isToe = TOE_BONE_PATTERN.test(object.name);
      const isAnkle = !isToe && ANKLE_BONE_PATTERN.test(object.name);
      if (!isToe && !isAnkle) return;
      object.getWorldPosition(local);
      this.root.worldToLocal(local);
      if (isToe) lowestToe = Math.min(lowestToe, local.y);
      else lowestAnkle = Math.min(lowestAnkle, local.y);
    });

    const usingToe = Number.isFinite(lowestToe);
    const lowest = usingToe ? lowestToe : lowestAnkle;
    if (!Number.isFinite(lowest)) return 0;

    const clearance = usingToe ? TOE_BONE_CLEARANCE : ANKLE_BONE_CLEARANCE;
    const correction = clearance - lowest;
    // A wild correction means the naming heuristic found the wrong bones;
    // the bind-pose placement is the safer answer in that case.
    if (Math.abs(correction) > MAX_FOOT_CORRECTION) return 0;
    model.position.y += correction;
    return correction;
  }

  static async load(entry: CharacterEntry, library?: AssetLibrary): Promise<Character> {
    const readBytes = async (ref: LibraryFileRef): Promise<LoadedModel> => {
      if (!library) throw new Error(`Character "${entry.key}" needs the asset library to load.`);
      return loadModelBytes(await library.readFileBytes(ref.fileId), ref.fileName);
    };
    const read = async (url?: string, ref?: LibraryFileRef): Promise<LoadedModel> => {
      if (url) return loadModelUrl(url);
      if (ref) return readBytes(ref);
      throw new Error(`Character "${entry.key}" has no loadable model source.`);
    };

    const model = await read(entry.modelUrl, entry.modelFile);
    const clips: Partial<Record<ClipRole, THREE.AnimationClip>> = {};
    const clipInfo: Partial<Record<ClipRole, ClipDescription>> = {};
    const authoredSpeeds: Partial<Record<ClipRole, number>> = {};

    // Measured here rather than in the constructor because a clip's travel is
    // in the source file's units, and this is the factor that turns it into
    // gameplay metres. The constructor recomputes the same number when it
    // normalizes the model.
    const rawHeight = Math.max(
      new THREE.Box3().setFromObject(model.scene).getSize(new THREE.Vector3()).y,
      0.01,
    );
    const target: RetargetTarget = {
      boneNames: collectBoneNames(model.scene),
      bones: collectBones(model.scene),
      normalizationScale: TARGET_HEIGHT / rawHeight,
    };

    const accept = (
      role: ClipRole,
      raw: THREE.AnimationClip,
      source: ClipSource,
      cached?: { measuredSpeed?: number; clipName?: string },
    ): void => {
      const prepared = prepareUploadedClip(raw, target);
      if (target.boneNames.size > 0 && prepared.bindRate < MIN_CLIP_BINDING) {
        // Leaving the role empty is what lets the borrow fallback below step
        // in. Filling it with a clip that binds to nothing would freeze the
        // body *and* suppress the fallback that would have saved it.
        console.warn(
          `Character "${entry.key}": ${role} clip "${raw.name}" only binds ` +
            `${Math.round(prepared.bindRate * 100)}% of its tracks to this skeleton — ignoring it.`,
        );
        return;
      }
      clips[role] = prepared.clip;
      clipInfo[role] = {
        role,
        clipName: cached?.clipName || raw.name || role,
        duration: prepared.clip.duration,
        bindRate: prepared.bindRate,
        unitScale: prepared.unitScale,
        rootMotion: prepared.hadRootMotion,
        source,
      };
      const speed = cached?.measuredSpeed ?? prepared.authoredSpeed ?? undefined;
      if (speed !== undefined) authoredSpeeds[role] = speed;
    };

    const roles: ClipRole[] = ['idle', 'walk', 'run', 'jump'];
    if (entry.clipRefs && entry.clipRefs.length > 0) {
      // Group by file so a multi-take export is parsed once and read N times.
      const byFile = new Map<string, CharacterClipRef[]>();
      for (const ref of entry.clipRefs) {
        const group = byFile.get(ref.fileId);
        if (group) group.push(ref);
        else byFile.set(ref.fileId, [ref]);
      }
      for (const [fileId, refs] of byFile) {
        const source =
          fileId === entry.modelFile?.fileId ? model : await readBytes(refs[0]);
        for (const ref of refs) {
          const raw = source.animations[ref.clipIndex];
          if (!raw) {
            console.warn(
              `Character "${entry.key}": ${refs[0].fileName} has no clip at index ${ref.clipIndex}.`,
            );
            continue;
          }
          accept(ref.role, raw, 'own', ref);
        }
      }
    } else {
      for (const role of roles) {
        const url = entry.clips[role];
        const ref = entry.clipFiles?.[role];
        if (!url && !ref) continue;
        if (url && url === entry.modelUrl) continue;
        const clipModel = await read(url, ref);
        const raw = clipModel.animations[0];
        if (raw) accept(role, raw, 'legacy');
      }
    }

    // A character whose clips are baked into the model file still needs
    // something to stand in as idle.
    if (!clips.idle && model.animations[0]) accept('idle', model.animations[0], 'own');

    // Anything still missing is borrowed from the shared locomotion set. An
    // animation track binds to a node by name, so a clip authored for one rig
    // plays on any skeleton using the same bone names — which is what lets an
    // uploaded character walk without being rigged again.
    const borrowed: ClipRole[] = [];
    if (target.boneNames.size > 0) {
      const loader = createMintGltfLoader();
      for (const role of roles) {
        if (clips[role]) continue;
        const shared = await loadSharedClip(role, loader);
        if (!shared) continue;
        const fitted = fitClipToSkeleton(shared, target.boneNames);
        // Below this the rig is a different skeleton, not a naming variant, and
        // playing the clip would only move part of the body.
        if (fitted.bindRate < MIN_CLIP_BINDING) continue;
        clips[role] = fitted.clip;
        clipInfo[role] = {
          role,
          clipName: shared.name || role,
          duration: fitted.clip.duration,
          bindRate: fitted.bindRate,
          unitScale: 1,
          rootMotion: false,
          source: 'borrowed',
        };
        borrowed.push(role);
      }
    }

    return new Character(entry, model.scene, clips, {
      borrowed,
      hasSkeleton: target.boneNames.size > 0,
      authoredSpeeds,
      clipInfo,
    });
  }

  /** What each role is playing and where it came from, for the UI and tests. */
  describeClips(): ClipDescription[] {
    return (['idle', 'walk', 'run', 'jump'] as ClipRole[])
      .map((role) => this.clipInfo[role])
      .filter((info): info is ClipDescription => Boolean(info));
  }

  /** Locomotion roles this character actually has clips for. */
  get availableRoles(): ClipRole[] {
    return [...this.actions.keys()];
  }

  /** Roles playing borrowed animation rather than the character's own. */
  get borrowedRoles(): ClipRole[] {
    return [...this.borrowed];
  }

  /** False for a plain mesh, which nothing can animate. */
  get hasSkeleton(): boolean {
    return this.rigged;
  }

  /** How the character is animated, for the UI to report honestly. */
  get animationSource(): 'own' | 'borrowed' | 'partial' | 'none' {
    if (!this.rigged) return 'none';
    if (this.actions.size === 0) return 'none';
    if (this.borrowed.length === 0) return 'own';
    return this.borrowed.length >= this.actions.size ? 'borrowed' : 'partial';
  }

  /** Call once on the frame the controller launches a jump. */
  triggerJump(): void {
    const jump = this.actions.get('jump');
    if (!jump) return;
    this.jumping = true;
    jump.reset().setEffectiveWeight(1).fadeIn(FADE_SECONDS * 0.5).play();
  }

  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
  }

  /** Fraction of the arms' sideways spread to remove; 0 disables the fix. */
  setArmNarrowing(value: number): number {
    this.armNarrowing = THREE.MathUtils.clamp(value, 0, 1);
    return this.armNarrowing;
  }

  get armTuck(): number {
    return this.armNarrowing;
  }

  /** Ground speed each locomotion clip was authored for, in m/s. */
  get clipSpeeds(): { walk: number; run: number; feet: number } {
    return { ...this.naturalSpeeds, feet: this.feet.length };
  }

  /**
   * Where the hips sit relative to the character's own origin, on the ground
   * plane. Surviving root motion shows up here as the body drifting away from
   * the controller that is supposed to be carrying it.
   */
  hipOffset(): { x: number; z: number } | null {
    if (!this.hips) return null;
    const local = this.hips.getWorldPosition(new THREE.Vector3());
    this.root.worldToLocal(local);
    return { x: local.x, z: local.z };
  }

  /** Bone names and the detected arm chain, for diagnosing an unknown rig. */
  describeRig(): { bones: string[]; arms: Array<{ side: string; bone: string; elbow: string }> } {
    const bones: string[] = [];
    this.root.traverse((object) => {
      if ((object as THREE.Bone).isBone) bones.push(object.name);
    });
    return {
      bones,
      arms: this.arms.map((arm) => ({
        side: arm.side,
        bone: arm.bone.name,
        elbow: arm.elbow.name,
      })),
    };
  }

  /**
   * Measured spread of each upper arm in degrees. `left`/`right` are the angle
   * in the frontal plane, which is what the correction rotates; `*Lateral` is
   * how far the arm points sideways overall, which stays meaningful even when
   * the arm has swung forward and the frontal projection gets small.
   */
  get armSpread(): ArmSpread & { bones: number } {
    return { ...this.lastArmSpread, bones: this.arms.length };
  }

  /**
   * Narrows flared arms toward the torso after the animation has posed the
   * skeleton. Two properties matter here:
   *
   * - It *scales* the spread rather than clamping it to a limit. Clamping made
   *   every frame past the limit land on the same angle, which flattened the
   *   arm's lateral movement into a constant and read as pinned and lifeless.
   *   Scaling keeps the shape of the motion and just narrows it.
   * - It rotates about the character's forward axis only, so the forward/back
   *   swing that carries the walk and run cycles is untouched.
   *
   * The forearm gets a share of the same rotation, otherwise the elbows come in
   * while the hands stay splayed.
   */
  private applyArmTuck(): void {
    if (this.arms.length === 0 || this.armNarrowing <= 0.001) return;
    // The correction premultiplies onto whatever the mixer just wrote. With no
    // clip driving the skeleton nothing rewrites it, so applying again each
    // frame would compound until the arms folded into the body.
    if (this.actions.size === 0) return;
    this.root.updateMatrixWorld(true);
    this.root.getWorldQuaternion(this.rootQuaternion);
    this.rootInverse.copy(this.rootQuaternion).invert();
    // The character's forward axis in world space; rotating about it swings the
    // arm through the frontal plane, which is exactly the flare.
    this.tuckAxis.set(0, 0, 1).applyQuaternion(this.rootQuaternion).normalize();

    for (const arm of this.arms) {
      const before = this.measureArm(arm);
      this.lastArmSpread[arm.side === 'left' ? 'leftBefore' : 'rightBefore'] = before.lateral;
      this.lastArmSpread[arm.side === 'left' ? 'leftAfter' : 'rightAfter'] = before.lateral;

      // Everything below is a smooth function of the pose. Hard cutoffs here
      // used to drop a large correction between one frame and the next, which
      // showed up as a pop as the arm swung through.
      const reach = Math.hypot(before.sideways, before.downward);
      const confidence =
        smoothstep(FRONTAL_FADE_IN, FRONTAL_FADE_OUT, reach) *
        smoothstep(0, DOWNWARD_FADE, before.downward);
      if (confidence <= 0.001) continue;

      const excess = Math.max(0, before.frontal - ARM_SPREAD_FLOOR);
      const correction =
        THREE.MathUtils.degToRad(Math.min(excess, MAX_ARM_TUCK)) *
        this.armNarrowing *
        confidence;
      if (correction <= 1e-4) continue;

      // Rotating about +forward carries +X down toward the body, so the sign
      // flips for the arm on the other side.
      const signed = before.sideways > 0 ? -correction : correction;
      this.rotateBoneAboutWorldAxis(arm.bone, signed);
      this.rotateBoneAboutWorldAxis(arm.elbow, signed * FOREARM_TUCK_SHARE);

      this.lastArmSpread[arm.side === 'left' ? 'leftAfter' : 'rightAfter'] =
        this.measureArm(arm).lateral;
    }
  }

  /** Applies a world-space rotation about `tuckAxis` to one bone's local pose. */
  private rotateBoneAboutWorldAxis(bone: THREE.Object3D, angle: number): void {
    const parent = bone.parent;
    if (!parent || Math.abs(angle) < 1e-5) return;
    this.tuckDelta.setFromAxisAngle(this.tuckAxis, angle);
    parent.getWorldQuaternion(this.parentWorld);
    this.parentInverse.copy(this.parentWorld).invert();
    // World-space delta rebased into the bone's parent space.
    this.rebasedDelta
      .copy(this.parentInverse)
      .multiply(this.tuckDelta)
      .multiply(this.parentWorld);
    bone.quaternion.premultiply(this.rebasedDelta);
    bone.updateMatrixWorld(true);
  }

  /** Arm direction in the character's own frame, plus the angles derived from it. */
  private measureArm(arm: ArmChain): {
    sideways: number;
    downward: number;
    frontal: number;
    lateral: number;
  } {
    arm.bone.getWorldPosition(this.armPivot);
    arm.elbow.getWorldPosition(this.armElbow);
    this.armDirection.subVectors(this.armElbow, this.armPivot);
    if (this.armDirection.lengthSq() < 1e-8) {
      return { sideways: 0, downward: 1, frontal: 0, lateral: 0 };
    }
    this.armDirection.normalize().applyQuaternion(this.rootInverse);
    const sideways = this.armDirection.x;
    const downward = -this.armDirection.y;
    return {
      sideways,
      downward,
      // Angle within the frontal plane, which is what the correction rotates.
      frontal: THREE.MathUtils.radToDeg(Math.atan2(Math.abs(sideways), Math.abs(downward))),
      // How far the arm points sideways overall, stable under forward swing.
      lateral: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(Math.abs(sideways), 0, 1))),
    };
  }

  /** Drive the blend tree from controller state; call every frame. */
  update(delta: number, horizontalSpeed: number, grounded: boolean): void {
    const idle = this.actions.get('idle');
    const walk = this.actions.get('walk');
    const run = this.actions.get('run');
    const jump = this.actions.get('jump');

    if (this.jumping && grounded) {
      this.jumping = false;
      jump?.fadeOut(FADE_SECONDS);
    }

    // Target locomotion weights from actual ground speed.
    const speed = horizontalSpeed;
    let idleTarget: number;
    let walkTarget: number;
    let runTarget: number;
    if (speed <= IDLE_FULL_BELOW) {
      idleTarget = 1;
      walkTarget = 0;
      runTarget = 0;
    } else if (speed < RUN_BLEND_START) {
      const t = Math.min(1, (speed - IDLE_FULL_BELOW) / (WALK_FULL_AT - IDLE_FULL_BELOW));
      idleTarget = 1 - t;
      walkTarget = t;
      runTarget = 0;
    } else {
      const t = Math.min(1, (speed - RUN_BLEND_START) / (RUN_FULL_AT - RUN_BLEND_START));
      idleTarget = 0;
      walkTarget = 1 - t;
      runTarget = t;
    }

    // While airborne the jump one-shot dominates; ground clips fade out.
    const airborne = this.jumping || !grounded;
    if (airborne) {
      idleTarget = 0;
      walkTarget = 0;
      runTarget = 0;
    }

    const lerp = 1 - Math.exp(-WEIGHT_LAMBDA * delta);
    this.weights.idle += (idleTarget - this.weights.idle) * lerp;
    this.weights.walk += (walkTarget - this.weights.walk) * lerp;
    this.weights.run += (runTarget - this.weights.run) * lerp;

    idle?.setEffectiveWeight(this.weights.idle);
    walk?.setEffectiveWeight(this.weights.walk);
    run?.setEffectiveWeight(this.weights.run);

    // Stride sync: play each cycle at the rate that makes its stride cover the
    // ground actually being travelled, using the speed measured from the clip.
    if (walk) {
      walk.timeScale = THREE.MathUtils.clamp(
        speed / this.naturalSpeeds.walk,
        MIN_TIME_SCALE,
        MAX_TIME_SCALE,
      );
    }
    if (run) {
      run.timeScale = THREE.MathUtils.clamp(
        speed / this.naturalSpeeds.run,
        MIN_TIME_SCALE,
        MAX_TIME_SCALE,
      );
    }

    // Walk and run free-run on independent clocks, so when they blend their
    // relative phase is arbitrary and the leg swings can partially cancel.
    // Align the incoming cycle to the outgoing one as the blend opens.
    if (walk && run && this.weights.walk > 0.01 && this.weights.run > 0.01) {
      if (!this.locomotionSynced) {
        const leader = this.weights.walk >= this.weights.run ? walk : run;
        const follower = leader === walk ? run : walk;
        const leaderDuration = leader.getClip().duration;
        const followerDuration = follower.getClip().duration;
        if (leaderDuration > 0) {
          const phase = (leader.time % leaderDuration) / leaderDuration;
          follower.time = phase * followerDuration;
        }
        this.locomotionSynced = true;
      }
    } else {
      this.locomotionSynced = false;
    }

    this.mixer.update(this.reducedMotion ? 0 : delta);
    this.applyArmTuck();
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
    disposeObject3D(this.root);
  }
}

type ArmSide = 'left' | 'right';

/** Lateral arm angles in degrees: 0 is at the side, 90 is a T-pose. */
interface ArmSpread {
  leftBefore: number;
  rightBefore: number;
  leftAfter: number;
  rightAfter: number;
}

interface ArmChain {
  side: ArmSide;
  bone: THREE.Bone;
  elbow: THREE.Object3D;
}

interface FootBone {
  side: ArmSide;
  bone: THREE.Object3D;
  isToe: boolean;
}

/** Nearest descendant that reads as a forearm, or failing that, any child. */
function findElbow(bone: THREE.Bone): THREE.Object3D | null {
  let named: THREE.Object3D | null = null;
  bone.traverse((child) => {
    if (child === bone || named) return;
    if (FOREARM_PATTERN.test(child.name)) named = child;
  });
  return named ?? bone.children.find((child) => (child as THREE.Bone).isBone) ?? null;
}

/** Shared locomotion clips, cached so every character reuses one parse. */
const sharedClipCache = new Map<ClipRole, Promise<THREE.AnimationClip | null>>();

function sharedClipUrl(role: ClipRole): string {
  return `${import.meta.env.BASE_URL}assets/clips/${role}.glb`;
}

async function loadSharedClip(
  role: ClipRole,
  loader: ReturnType<typeof createMintGltfLoader>,
): Promise<THREE.AnimationClip | null> {
  let pending = sharedClipCache.get(role);
  if (!pending) {
    pending = loader
      .loadAsync(sharedClipUrl(role))
      .then((gltf) => gltf.animations[0] ?? null)
      .catch((error) => {
        console.warn(`Shared ${role} clip unavailable.`, error);
        return null;
      });
    sharedClipCache.set(role, pending);
  }
  return pending;
}

/** Smooth 0..1 ramp, so corrections fade in rather than switching on. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function isDescendantOf(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** Opts the character into the scene's world-derived environment lighting. */
function prepareMaterials(model: THREE.Group): void {
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      if (!standard.isMeshStandardMaterial) continue;
      standard.envMapIntensity = CHARACTER_ENV_MAP_INTENSITY;
      standard.needsUpdate = true;
    }
  });
}
