import * as THREE from 'three';
import { HIPS_BONE_PATTERN, normalizeBoneName } from './rig-names';

export { normalizeBoneName };

/** Fraction of a clip's tracks that must bind for it to be usable. */
export const MIN_CLIP_BINDING = 0.6;
/**
 * Below this the hips have not really gone anywhere. Measured in metres at
 * gameplay scale rather than in the file's own units, because a rig authored in
 * centimetres would otherwise clear any fixed threshold on jitter alone — and a
 * clip wrongly labelled as having root motion reports a ground speed of
 * roughly zero, which is worse than reporting nothing.
 */
const MIN_ROOT_MOTION_METRES = 0.05;
/** Speeds outside this range are not a believable reading of a locomotion cycle. */
const MIN_AUTHORED_SPEED = 0.1;
const MAX_AUTHORED_SPEED = 12;
/** Unit ratios worth snapping to: cm, inches, metres, inches-per-metre, cm-per-metre. */
const KNOWN_UNIT_RATIOS = [0.01, 0.0254, 1, 39.3701, 100];
const UNIT_SNAP_TOLERANCE = 0.1;
/** Ratios inside this band are treated as 1 — rig noise, not a unit mismatch. */
const UNIT_DEAD_BAND: [number, number] = [0.5, 2];

export interface FitResult {
  clip: THREE.AnimationClip;
  bound: number;
  total: number;
  bindRate: number;
}

export interface RootMotionResult {
  hadRootMotion: boolean;
  /** Travel over the clip, converted to metres at gameplay scale. */
  authoredSpeed: number | null;
}

export interface RetargetTarget {
  boneNames: Set<string>;
  bones: Map<string, THREE.Bone>;
  /** TARGET_HEIGHT / raw model height — converts file units to gameplay metres. */
  normalizationScale: number;
}

export interface PreparedClip {
  clip: THREE.AnimationClip;
  bindRate: number;
  unitScale: number;
  hadRootMotion: boolean;
  authoredSpeed: number | null;
}

export function collectBoneNames(model: THREE.Object3D): Set<string> {
  const names = new Set<string>();
  model.traverse((object) => {
    if ((object as THREE.Bone).isBone) names.add(object.name);
  });
  return names;
}

export function collectBones(model: THREE.Object3D): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  model.traverse((object) => {
    if ((object as THREE.Bone).isBone && !bones.has(object.name)) {
      bones.set(object.name, object as THREE.Bone);
    }
  });
  return bones;
}

function trackNode(track: THREE.KeyframeTrack): string {
  return track.name.split('.')[0];
}

function isPositionTrack(track: THREE.KeyframeTrack): boolean {
  return track.name.endsWith('.position');
}

/**
 * Rewrites a clip's track names onto the target skeleton when the two rigs use
 * the same bones under different spellings — `mixamorig:LeftArm` vs `LeftArm`,
 * or `upper_arm.L` vs `LeftUpperArm`.
 *
 * Always returns a clone. Callers mutate the result (unit rescaling, root
 * motion stripping) and the input may be a cached shared clip handed to every
 * character that loads, so returning the caller's own object would leak those
 * edits across characters.
 */
export function fitClipToSkeleton(clip: THREE.AnimationClip, boneNames: Set<string>): FitResult {
  const fitted = clip.clone();
  const total = fitted.tracks.length;
  if (total === 0) return { clip: fitted, bound: 0, total: 0, bindRate: 0 };

  const normalized = new Map<string, string>();
  for (const name of boneNames) normalized.set(normalizeBoneName(name), name);

  let bound = 0;
  for (const track of fitted.tracks) {
    const node = trackNode(track);
    if (boneNames.has(node)) {
      bound += 1;
      continue;
    }
    const match = normalized.get(normalizeBoneName(node));
    if (match) {
      track.name = `${match}${track.name.slice(node.length)}`;
      bound += 1;
    }
  }

  return { clip: fitted, bound, total, bindRate: bound / total };
}

/** Bones from the skeleton root down to and including the hips. */
function rootChainNames(bones: Map<string, THREE.Bone>): Set<string> {
  const chain = new Set<string>();
  if (bones.size === 0) return chain;

  const depthOf = (bone: THREE.Bone): number => {
    let depth = 0;
    let current: THREE.Object3D | null = bone.parent;
    while (current) {
      if ((current as THREE.Bone).isBone) depth += 1;
      current = current.parent;
    }
    return depth;
  };

  let hips: THREE.Bone | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const bone of bones.values()) {
    if (!HIPS_BONE_PATTERN.test(bone.name)) continue;
    const depth = depthOf(bone);
    if (depth < best) {
      best = depth;
      hips = bone;
    }
  }
  if (!hips) {
    // No hips-like name: fall back to the shallowest bone in the rig.
    for (const bone of bones.values()) {
      const depth = depthOf(bone);
      if (depth < best) {
        best = depth;
        hips = bone;
      }
    }
  }
  if (!hips) return chain;

  let current: THREE.Object3D | null = hips;
  while (current) {
    if ((current as THREE.Bone).isBone) chain.add(current.name);
    current = current.parent;
  }
  return chain;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianTrackMagnitude(track: THREE.KeyframeTrack): number {
  const values = track.values;
  const magnitudes: number[] = [];
  for (let i = 0; i + 2 < values.length; i += 3) {
    magnitudes.push(Math.hypot(values[i], values[i + 1], values[i + 2]));
  }
  return median(magnitudes);
}

function medianComponent(track: THREE.KeyframeTrack, offset: number): number {
  const values = track.values;
  const components: number[] = [];
  for (let i = offset; i < values.length; i += 3) components.push(values[i]);
  return median(components);
}

/**
 * How much larger the clip's translation values are than the target rig's own
 * bind pose. Mixamo authors in centimetres, so a clip dropped onto a rig
 * exported in metres would otherwise blow the limbs apart by 100x.
 *
 * Limb `.position` tracks in a retargeted clip are constant and equal to bone
 * length, which makes them directly comparable to the target bone's bind-pose
 * local translation. `Character` scales the model *group*, never the bones, so
 * bone-local translations stay in the source file's units — which is what makes
 * this comparison correct, and why a matching body/clip pair yields exactly 1.
 */
export function detectClipUnitScale(
  clip: THREE.AnimationClip,
  bones: Map<string, THREE.Bone>,
): number {
  if (bones.size === 0) return 1;
  const rootChain = rootChainNames(bones);
  const samples: number[] = [];

  for (const track of clip.tracks) {
    if (!isPositionTrack(track)) continue;
    const name = trackNode(track);
    if (rootChain.has(name)) continue; // Animated translation, not a bone length.
    const bone = bones.get(name);
    if (!bone) continue;
    const bindLength = bone.position.length();
    if (bindLength < 1e-4) continue;
    const trackLength = medianTrackMagnitude(track);
    if (trackLength < 1e-6) continue;
    samples.push(trackLength / bindLength);
  }

  let ratio: number;
  if (samples.length > 0) {
    ratio = median(samples);
  } else {
    // Common for in-place GLB exports: only the hips translate, so there are no
    // constant limb tracks to compare. Fall back to hip height.
    const hipsName = [...rootChain].find((name) => HIPS_BONE_PATTERN.test(name));
    const hipsBone = hipsName ? bones.get(hipsName) : undefined;
    const hipsTrack = clip.tracks.find(
      (track) => isPositionTrack(track) && trackNode(track) === hipsName,
    );
    if (!hipsBone || !hipsTrack) return 1;
    const bindY = Math.abs(hipsBone.position.y);
    if (bindY < 1e-4) return 1;
    ratio = Math.abs(medianComponent(hipsTrack, 1)) / bindY;
  }

  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  if (ratio >= UNIT_DEAD_BAND[0] && ratio <= UNIT_DEAD_BAND[1]) return 1;
  for (const known of KNOWN_UNIT_RATIOS) {
    if (Math.abs(ratio - known) / known <= UNIT_SNAP_TOLERANCE) return known;
  }
  return ratio;
}

/** Multiplies every translation keyframe by `factor`, in place. */
export function rescalePositionTracks(clip: THREE.AnimationClip, factor: number): void {
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 1e-6) return;
  for (const track of clip.tracks) {
    if (!isPositionTrack(track)) continue;
    const values = track.values;
    for (let i = 0; i < values.length; i += 1) values[i] *= factor;
  }
}

/**
 * Neutralises horizontal root motion so the mesh stays under the controller,
 * which owns position. Mixamo takes typically translate the hips forward over
 * the clip; played as-is the body walks away from its own collider.
 *
 * The *linear* drift is subtracted rather than the track being flattened to a
 * constant: flattening also kills the side-to-side hip sway that makes a walk
 * read as a walk, whereas subtracting the ramp keeps the sway and leaves the
 * cycle looping seamlessly in XZ. Y is never touched — the vertical bob is
 * exactly what we want to keep.
 *
 * The drift we remove is also the best available reading of the clip's authored
 * ground speed, so it is returned rather than thrown away.
 */
export function stripRootMotion(
  clip: THREE.AnimationClip,
  bones: Map<string, THREE.Bone>,
  normalizationScale: number,
): RootMotionResult {
  const rootChain = rootChainNames(bones);
  if (rootChain.size === 0) return { hadRootMotion: false, authoredSpeed: null };

  let maxDistance = 0;
  let stripped = false;

  for (const track of clip.tracks) {
    if (!isPositionTrack(track)) continue;
    if (!rootChain.has(trackNode(track))) continue;

    const times = track.times;
    const values = track.values;
    const frames = Math.min(times.length, Math.floor(values.length / 3));
    if (frames < 2) continue;

    const span = times[frames - 1] - times[0];
    if (span <= 0) continue;

    const last = (frames - 1) * 3;
    const dx = values[last] - values[0];
    const dz = values[last + 2] - values[2];
    const distance = Math.hypot(dx, dz);
    if (distance * normalizationScale < MIN_ROOT_MOTION_METRES) continue;

    for (let i = 0; i < frames; i += 1) {
      const t = (times[i] - times[0]) / span;
      values[i * 3] -= t * dx;
      values[i * 3 + 2] -= t * dz;
    }

    // Re-centre so the de-drifted cycle sits over the root rather than off to
    // one side of where it happened to start.
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < frames; i += 1) {
      sumX += values[i * 3];
      sumZ += values[i * 3 + 2];
    }
    const meanX = sumX / frames;
    const meanZ = sumZ / frames;
    if (Math.abs(meanX) > 1e-4 || Math.abs(meanZ) > 1e-4) {
      for (let i = 0; i < frames; i += 1) {
        values[i * 3] -= meanX;
        values[i * 3 + 2] -= meanZ;
      }
    }

    stripped = true;
    maxDistance = Math.max(maxDistance, distance);
  }

  if (!stripped) return { hadRootMotion: false, authoredSpeed: null };
  const duration = clip.duration;
  const speed = duration > 0 ? (maxDistance * normalizationScale) / duration : 0;
  const believable =
    Number.isFinite(speed) && speed >= MIN_AUTHORED_SPEED && speed <= MAX_AUTHORED_SPEED;
  return { hadRootMotion: true, authoredSpeed: believable ? speed : null };
}

/**
 * The single entry point for turning a clip out of an uploaded file into
 * something safe to play on a given character: retarget names, correct units,
 * then neutralise root motion.
 *
 * Order matters. Fitting first means bone lookups resolve for the two steps
 * that follow; rescaling before stripping means the drift distance comes out in
 * the skeleton's own units, which is what `normalizationScale` converts from.
 */
export function prepareUploadedClip(
  raw: THREE.AnimationClip,
  target: RetargetTarget,
): PreparedClip {
  const fit = fitClipToSkeleton(raw, target.boneNames);
  const unitScale = detectClipUnitScale(fit.clip, target.bones);
  if (unitScale !== 1) rescalePositionTracks(fit.clip, 1 / unitScale);
  const root = stripRootMotion(fit.clip, target.bones, target.normalizationScale);
  return {
    clip: fit.clip,
    bindRate: fit.bindRate,
    unitScale,
    hadRootMotion: root.hadRootMotion,
    authoredSpeed: root.authoredSpeed,
  };
}
