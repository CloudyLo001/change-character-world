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
    prepareMaterials(model);
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
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
    disposeObject3D(this.root);
  }
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
