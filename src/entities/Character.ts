import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { createMintGltfLoader } from '../assets/gltf-runtime';
import { disposeObject3D } from '../utils/dispose';
import type { AssetLibrary } from '../mint/library';
import type { CharacterEntry, ClipRole, LibraryFileRef } from '../mint/registry';

export type { ClipRole };

const TARGET_HEIGHT = 1.75;
const FADE_SECONDS = 0.18;
// Ground speeds (m/s) the walk/run cycles read as natural at timeScale 1.
// timeScale is scaled by actual controller speed so strides match the ground
// and feet stop sliding.
const WALK_REFERENCE_SPEED = 1.5;
const RUN_REFERENCE_SPEED = 4.8;
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
const TOE_BONE_PATTERN = /toe|ball/i;
const ANKLE_BONE_PATTERN = /foot|ankle/i;
// Mint rigs characters from a T-pose, so retargeted arms sit wider than the
// source clip intends — worse the bulkier the shoulders. These find the upper
// arm bone and the elbow below it so the spread can be measured and corrected.
// Rigs are commonly CamelCase (LeftArm/LeftForeArm) or delimited
// (upper_arm.L), so these must match inside a word as well as at boundaries.
const UPPER_ARM_PATTERN = /(upper.?arm|shoulder|arm)/i;
const FOREARM_PATTERN = /(fore.?arm|lower.?arm|elbow)/i;
const LEFT_PATTERN = /(left|(^|[^a-z])l($|[^a-z]))/i;
const RIGHT_PATTERN = /(right|(^|[^a-z])r($|[^a-z]))/i;
/** Degrees the upper arm may sit off the torso before it reads as flared. */
const DEFAULT_ARM_TUCK_TARGET = 10;
const MAX_ARM_TUCK = 55;
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
  private jumpWeight = 0;
  private jumping = false;
  private reducedMotion = false;
  /** How far the posed feet had to be corrected off the bind-pose estimate. */
  readonly footCorrection: number;

  private readonly arms: ArmChain[] = [];
  private armTuckTarget = DEFAULT_ARM_TUCK_TARGET;
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

  private constructor(
    readonly entry: CharacterEntry,
    model: THREE.Group,
    clips: Partial<Record<ClipRole, THREE.AnimationClip>>,
  ) {
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
    prepareMaterials(model);
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
    const loader = createMintGltfLoader();
    const read = async (url?: string, ref?: LibraryFileRef): Promise<GLTF> => {
      if (url) return loader.loadAsync(url);
      if (ref && library) return loader.parseAsync(await library.readFileBytes(ref.fileId), '');
      throw new Error(`Character "${entry.key}" has no loadable model source.`);
    };

    const modelGltf = await read(entry.modelUrl, entry.modelFile);
    const clips: Partial<Record<ClipRole, THREE.AnimationClip>> = {};

    const roles: ClipRole[] = ['idle', 'walk', 'run', 'jump'];
    for (const role of roles) {
      const url = entry.clips[role];
      const ref = entry.clipFiles?.[role];
      if (!url && !ref) continue;
      if (url && url === entry.modelUrl) continue;
      const clipGltf = await read(url, ref);
      const clip = clipGltf.animations[0];
      if (clip) clips[role] = clip;
    }
    // A character uploaded with its clips baked into the GLB, or with no clips
    // at all, still needs something to stand in as idle.
    if (!clips.idle && modelGltf.animations[0]) clips.idle = modelGltf.animations[0];
    if (Object.keys(clips).length === 0 && modelGltf.animations.length > 0) {
      clips.idle = modelGltf.animations[0];
    }

    return new Character(entry, modelGltf.scene, clips);
  }

  /** Locomotion roles this character actually has clips for. */
  get availableRoles(): ClipRole[] {
    return [...this.actions.keys()];
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

  /** Degrees of sideways spread allowed before the arms are pulled in. */
  setArmTuckTarget(degrees: number): number {
    this.armTuckTarget = THREE.MathUtils.clamp(degrees, 0, 90);
    return this.armTuckTarget;
  }

  get armTuck(): number {
    return this.armTuckTarget;
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
   * Pulls flared arms back toward the torso after the animation has posed the
   * skeleton. Only the sideways component is touched — the correction rotates
   * about the character's forward axis — so the forward/back arm swing that
   * carries the walk and run cycles is preserved exactly as animated.
   */
  private applyArmTuck(): void {
    if (this.arms.length === 0) return;
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

      const excess = before.frontal - this.armTuckTarget;
      if (excess <= 0.01 || before.downward <= 0) continue;
      // An arm swung far forward has almost no frontal projection, which makes
      // the angle jittery; there is no visible flare to correct there anyway.
      if (Math.hypot(before.sideways, before.downward) < 0.25) continue;
      const correction = THREE.MathUtils.degToRad(Math.min(excess, MAX_ARM_TUCK));

      // Rotating about +forward carries +X down toward the body, so the sign
      // flips for the arm on the other side.
      this.tuckDelta.setFromAxisAngle(
        this.tuckAxis,
        before.sideways > 0 ? -correction : correction,
      );

      const parent = arm.bone.parent;
      if (!parent) continue;
      parent.getWorldQuaternion(this.parentWorld);
      this.parentInverse.copy(this.parentWorld).invert();
      // World-space delta rebased into the bone's parent space.
      arm.bone.quaternion.premultiply(
        this.parentInverse.clone().multiply(this.tuckDelta).multiply(this.parentWorld),
      );
      arm.bone.updateMatrixWorld(true);

      this.lastArmSpread[arm.side === 'left' ? 'leftAfter' : 'rightAfter'] =
        this.measureArm(arm).lateral;
    }
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
    this.jumpWeight += ((airborne ? 1 : 0) - this.jumpWeight) * lerp;

    idle?.setEffectiveWeight(this.weights.idle);
    walk?.setEffectiveWeight(this.weights.walk);
    run?.setEffectiveWeight(this.weights.run);

    // Stride sync: cycle rate follows actual ground speed.
    if (walk) {
      walk.timeScale = THREE.MathUtils.clamp(speed / WALK_REFERENCE_SPEED, 0.6, 1.7);
    }
    if (run) {
      run.timeScale = THREE.MathUtils.clamp(speed / RUN_REFERENCE_SPEED, 0.6, 1.4);
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

/** Nearest descendant that reads as a forearm, or failing that, any child. */
function findElbow(bone: THREE.Bone): THREE.Object3D | null {
  let named: THREE.Object3D | null = null;
  bone.traverse((child) => {
    if (child === bone || named) return;
    if (FOREARM_PATTERN.test(child.name)) named = child;
  });
  return named ?? bone.children.find((child) => (child as THREE.Bone).isBone) ?? null;
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
