import { scoreNameForRoles, type ClipRole } from '../mint/registry';
import { MIN_CLIP_BINDING } from './clip-fit';
import type { ClipMetrics } from './ClipHarness';

/**
 * Works out which uploaded clip is the idle, which is the walk, and so on.
 *
 * Filenames alone are not enough: a Mint or Mixamo export is as likely to be
 * `anim_01.glb` holding a clip called `Walking` as it is to be named usefully,
 * and one file can hold half a dozen takes that obviously cannot all inherit
 * the filename. So three signals are weighed — the clip's own name, the
 * filename, and what the motion actually does — and the user gets the final say
 * in the review step regardless.
 */

/** A role, or the explicit decision not to use a clip. */
export type RoleAssignment = ClipRole | 'unused';

export const ROLES: readonly ClipRole[] = ['idle', 'walk', 'run', 'jump'];

const NAME_WEIGHT = 0.45;
const FILE_WEIGHT = 0.2;
const MOTION_WEIGHT = 0.35;
/** Below this nothing is auto-assigned; the row lands on "unused". */
const MIN_AUTO_SCORE = 0.35;

/**
 * Names exporters emit that carry no meaning. These score zero for every role
 * rather than counting against one, so motion analysis is left to decide.
 */
const JUNK_NAME_PATTERNS: RegExp[] = [
  /^mixamo\.com$/i,
  /^take[\s._-]*\d*$/i,
  /^(armature|scene|animation|action|clip|default)[\s._|-]*\d*$/i,
  /^(base)?layer\d*$/i,
  /^anim(ation)?[\s._-]?\d+$/i,
  /^\d+$/,
];

export interface ClipCandidate {
  fileId: string;
  fileName: string;
  clipIndex: number;
  clipName: string;
  metrics: ClipMetrics;
  bindRate: number;
  /** How many clips the source file holds; 1 means the filename describes it. */
  clipsInFile: number;
}

export interface Classification {
  role: RoleAssignment;
  confidence: number;
  /** Per-role scores, so the UI can explain a surprising choice. */
  scores: Record<ClipRole, number>;
}

/**
 * The part of a clip's name that says anything about what it is.
 *
 * Exporters pipe-delimit their own bookkeeping into the name —
 * `Armature|Proud_Strut_inplace|baselayer` — so the segments are filtered
 * individually rather than the whole string being judged by its last one, which
 * would throw away the only segment that matters.
 */
export function meaningfulClipName(name: string): string {
  return name
    .split('|')
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        segment.length > 0 && !JUNK_NAME_PATTERNS.some((pattern) => pattern.test(segment)),
    )
    .join(' ');
}

export function isJunkClipName(name: string): boolean {
  return meaningfulClipName(name).length === 0;
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]+$/i, '');
}

/** 1 below `full`, 0 above `zero`, linear between. */
function falling(value: number, full: number, zero: number): number {
  if (value <= full) return 1;
  if (value >= zero) return 0;
  return (zero - value) / (zero - full);
}

/** 0 below `zero`, 1 above `full`, linear between. */
function rising(value: number, zero: number, full: number): number {
  if (value <= zero) return 0;
  if (value >= full) return 1;
  return (value - zero) / (full - zero);
}

/** 1 across the plateau, tapering to 0 at the outer edges. */
function bell(
  value: number,
  zeroLow: number,
  fullLow: number,
  fullHigh: number,
  zeroHigh: number,
): number {
  if (value <= zeroLow || value >= zeroHigh) return 0;
  if (value >= fullLow && value <= fullHigh) return 1;
  return value < fullLow
    ? (value - zeroLow) / (fullLow - zeroLow)
    : (zeroHigh - value) / (zeroHigh - fullHigh);
}

function motionScores(metrics: ClipMetrics): Record<ClipRole, number> {
  const speed = metrics.groundSpeed;
  // An unmeasurable rig gives no motion signal at all — better to defer to the
  // names than to invent a reading.
  if (speed === null) return { idle: 0, walk: 0, run: 0, jump: 0 };

  const { airTime, hipBob, loops } = metrics;
  return {
    idle: falling(speed, 0.25, 0.6) * (airTime < 0.02 ? 1 : 0) * falling(hipBob, 0.06, 0.1),
    walk: bell(speed, 0.4, 0.8, 2.0, 2.8) * (airTime < 0.05 ? 1 : 0.3),
    run: bell(speed, 2.0, 2.6, 6.0, 8.0) * (airTime >= 0.03 && airTime <= 0.45 ? 1 : 0.6),
    jump:
      Math.max(rising(airTime, 0.25, 0.5), hipBob > 0.25 && speed < 1 ? 0.8 : 0) *
      (loops ? 0.4 : 1),
  };
}

function scoreCandidate(candidate: ClipCandidate): Record<ClipRole, number> {
  const meaningful = meaningfulClipName(candidate.clipName);
  const nameScores = meaningful ? scoreNameForRoles(meaningful) : {};
  // A six-take file called `walking.fbx` must not label all six as walk.
  const fileScores =
    candidate.clipsInFile === 1 ? scoreNameForRoles(baseName(candidate.fileName)) : {};
  const motion = motionScores(candidate.metrics);
  // A clip that does not bind to this skeleton is not evidence of anything;
  // gating here keeps it out of auto-assignment while leaving it selectable.
  const usable = candidate.bindRate >= MIN_CLIP_BINDING;

  const scores = {} as Record<ClipRole, number>;
  for (const role of ROLES) {
    scores[role] =
      NAME_WEIGHT * (nameScores[role] ?? 0) +
      FILE_WEIGHT * (fileScores[role] ?? 0) +
      MOTION_WEIGHT * (usable ? motion[role] : 0);
  }
  return scores;
}

/**
 * Assigns at most one clip per role, greedily taking the strongest pairing
 * first. The candidate set is a handful of clips, so an exhaustive pass over
 * the whole grid costs nothing and avoids the ordering artefacts a single
 * left-to-right sweep produces.
 *
 * Returns one entry per candidate, in the order given.
 */
export function classifyClips(candidates: ClipCandidate[]): Classification[] {
  const scored = candidates.map(scoreCandidate);
  const result: Classification[] = candidates.map((_, index) => ({
    role: 'unused',
    confidence: 0,
    scores: scored[index],
  }));

  const takenRoles = new Set<ClipRole>();
  const takenClips = new Set<number>();

  for (;;) {
    let bestIndex = -1;
    let bestRole: ClipRole | null = null;
    let bestScore = MIN_AUTO_SCORE;
    for (let index = 0; index < candidates.length; index += 1) {
      if (takenClips.has(index)) continue;
      for (const role of ROLES) {
        if (takenRoles.has(role)) continue;
        const score = scored[index][role];
        if (score < bestScore) continue;
        if (score > bestScore || bestIndex === -1) {
          bestScore = score;
          bestIndex = index;
          bestRole = role;
          continue;
        }
        // Ties go to the clip that binds better, then to the longer take.
        const incumbent = candidates[bestIndex];
        const challenger = candidates[index];
        if (
          challenger.bindRate > incumbent.bindRate ||
          (challenger.bindRate === incumbent.bindRate &&
            challenger.metrics.duration > incumbent.metrics.duration)
        ) {
          bestIndex = index;
          bestRole = role;
        }
      }
    }
    if (bestIndex === -1 || !bestRole) break;
    result[bestIndex].role = bestRole;
    result[bestIndex].confidence = bestScore;
    takenRoles.add(bestRole);
    takenClips.add(bestIndex);
  }

  return result;
}
