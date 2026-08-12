/**
 * Bone-name heuristics shared by the character, the measurement harness and the
 * clip classifier. Rigs are commonly CamelCase (`LeftFoot`, `LeftToeBase`) or
 * delimited (`foot.L`), so every pattern here must match *inside* a word as
 * well as at a boundary — `\bfoot\b` would never match `LeftFoot`.
 */

export const TOE_BONE_PATTERN = /toe|ball/i;
export const ANKLE_BONE_PATTERN = /foot|ankle/i;
export const UPPER_ARM_PATTERN = /(upper.?arm|shoulder|arm)/i;
export const FOREARM_PATTERN = /(fore.?arm|lower.?arm|elbow)/i;
export const LEFT_PATTERN = /(left|(^|[^a-z])l($|[^a-z]))/i;
export const RIGHT_PATTERN = /(right|(^|[^a-z])r($|[^a-z]))/i;
/** The pelvis, which every locomotion clip translates and which carries the bob. */
export const HIPS_BONE_PATTERN = /hips?|pelvis|root/i;

export type RigSide = 'left' | 'right';

/** Which side of the body a bone name reads as, or null when it is central. */
export function boneSide(name: string): RigSide | null {
  if (LEFT_PATTERN.test(name)) return 'left';
  if (RIGHT_PATTERN.test(name)) return 'right';
  return null;
}

/**
 * Collapses common rig naming conventions to a comparable form, so a clip
 * authored on `mixamorig:LeftArm` can be matched against a rig's `LeftArm` or
 * `upper_arm.L`.
 */
export function normalizeBoneName(name: string): string {
  let value = name.toLowerCase();
  value = value.replace(/^mixamorig[:_]?/, '');
  // Trailing side markers (`arm.l`, `arm_r`) become a leading word instead, so
  // they line up with `leftarm` / `rightarm`.
  const side = /[._-]([lr])$/.exec(value);
  if (side) {
    value = `${side[1] === 'l' ? 'left' : 'right'}${value.slice(0, side.index)}`;
  }
  return value.replace(/[^a-z0-9]/g, '');
}
