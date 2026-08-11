import * as THREE from 'three';
import {
  getSplatFileType,
  SplatFileType,
  SplatMesh,
  type SplatMeshOptions,
} from '@sparkjsdev/spark';
import { createMintGltfLoader } from '../assets/gltf-runtime';
import { disposeObject3D } from '../utils/dispose';
import type { AssetLibrary } from '../mint/library';
import type { WorldEntry } from '../mint/registry';

export interface LoadedWorld {
  entry: WorldEntry;
  root: THREE.Group;
  splat: SplatMesh;
  collider: THREE.Object3D | null;
  colliderMeshes: THREE.Mesh[];
}

/**
 * Owns the currently loaded splat world. The splat and its invisible collider
 * GLB always share one root transform; gameplay raycasts run against the
 * collider meshes when a world has one, and against the splats when it does not.
 */
export class MintWorldManager {
  private current: LoadedWorld | null = null;
  private loadToken = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly library: AssetLibrary,
  ) {}

  get world(): LoadedWorld | null {
    return this.current;
  }

  get colliderMeshes(): THREE.Mesh[] {
    return this.current?.colliderMeshes ?? [];
  }

  async load(entry: WorldEntry): Promise<LoadedWorld | null> {
    const token = ++this.loadToken;

    const root = new THREE.Group();
    root.name = `mint-world:${entry.key}`;
    root.position.fromArray(entry.transform.position);
    root.rotation.set(...entry.transform.rotation);
    root.scale.fromArray(entry.transform.scale);

    const splat = new SplatMesh({
      ...(await this.splatSource(entry)),
      // Gameplay rays only ever target the collider array, but keeping the
      // splats raycastable lets us measure the visible surface once per world
      // to calibrate the collider-to-surface gap — and for uploaded worlds,
      // which ship without a collider, they are the ground.
      raycastable: true,
      // Soft, low-opacity surface splats (grass, haze) still count as ground
      // for the purposes of measuring where the visible surface sits.
      minRaycastOpacity: 0.12,
    });
    root.add(splat);

    const colliderPromise = this.loadCollider(entry);

    try {
      const [, colliderScene] = await Promise.all([splat.initialized, colliderPromise]);
      if (token !== this.loadToken) {
        // A newer load superseded this one while it streamed in.
        disposeSplat(splat);
        if (colliderScene) disposeObject3D(colliderScene);
        return null;
      }

      const colliderMeshes: THREE.Mesh[] = [];
      if (colliderScene) {
        colliderScene.name = `mint-world-collider:${entry.key}`;
        root.add(colliderScene);
        colliderScene.traverse((object) => {
          object.visible = false;
          if ((object as THREE.Mesh).isMesh) colliderMeshes.push(object as THREE.Mesh);
        });
      }

      this.unloadCurrent();
      this.scene.add(root);
      root.updateMatrixWorld(true);

      this.current = { entry, root, splat, collider: colliderScene, colliderMeshes };
      return this.current;
    } catch (error) {
      disposeSplat(splat);
      if (token === this.loadToken) throw error;
      return null;
    }
  }

  /** Remote Mint worlds stream by URL; uploaded worlds are decoded from bytes. */
  private async splatSource(entry: WorldEntry): Promise<SplatMeshOptions> {
    if (entry.runtimeUrl) {
      return { url: entry.runtimeUrl, fileType: SplatFileType.RAD, paged: true };
    }
    if (!entry.splatFile) throw new Error(`World "${entry.key}" has no splat source.`);
    const bytes = await this.library.readFileBytes(entry.splatFile.fileId);
    // Sniff the container from the bytes; fall back to the file extension for
    // formats whose header Spark cannot identify on its own.
    const fileType =
      getSplatFileType(new Uint8Array(bytes)) ?? splatTypeFromName(entry.splatFile.fileName);
    if (!fileType) {
      throw new Error(`Unrecognized splat file: ${entry.splatFile.fileName}`);
    }
    // Local files are already resident, so there is nothing to page in.
    return { fileBytes: bytes, fileType, fileName: entry.splatFile.fileName };
  }

  private async loadCollider(entry: WorldEntry): Promise<THREE.Group | null> {
    const loader = createMintGltfLoader();
    if (entry.colliderUrl) return (await loader.loadAsync(entry.colliderUrl)).scene;
    if (entry.colliderFile) {
      const bytes = await this.library.readFileBytes(entry.colliderFile.fileId);
      return (await loader.parseAsync(bytes, '')).scene;
    }
    // Uploaded splat worlds have no collision mesh; the splats themselves are
    // the ground (see SplatGround).
    return null;
  }

  /**
   * Height of the *visible* splat surface near a world position. The ray starts
   * just above `fromY` rather than high in the air, because an open world's sky
   * dome is itself made of splats and would otherwise be the first hit. Splat
   * raycasting walks the resident splats on the CPU, so call this sparingly —
   * once per world load, not per frame.
   */
  sampleSplatHeight(x: number, z: number, fromY: number, reach: number): number | null {
    const world = this.current;
    if (!world) return null;
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(x, fromY + reach, z),
      new THREE.Vector3(0, -1, 0),
      0,
      reach * 2,
    );
    const hits = raycaster.intersectObject(world.splat, false);
    return hits.length > 0 ? hits[0].point.y : null;
  }

  /** True when `load` has been called again after this call's token was taken. */
  isStale(token: number): boolean {
    return token !== this.loadToken;
  }

  takeToken(): number {
    return ++this.loadToken;
  }

  /** True when this world relies on its splats for ground collision. */
  get usesSplatGround(): boolean {
    return this.current !== null && this.current.colliderMeshes.length === 0;
  }

  unloadCurrent(): void {
    if (!this.current) return;
    this.scene.remove(this.current.root);
    disposeSplat(this.current.splat);
    if (this.current.collider) disposeObject3D(this.current.collider);
    this.current = null;
  }

  dispose(): void {
    this.loadToken += 1;
    this.unloadCurrent();
  }
}

const SPLAT_TYPE_BY_EXTENSION: Record<string, SplatFileType> = {
  rad: SplatFileType.RAD,
  spz: SplatFileType.SPZ,
  ply: SplatFileType.PLY,
  splat: SplatFileType.SPLAT,
  ksplat: SplatFileType.KSPLAT,
};

function splatTypeFromName(name: string): SplatFileType | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? SPLAT_TYPE_BY_EXTENSION[match[1].toLowerCase()] : undefined;
}

function disposeSplat(splat: SplatMesh): void {
  const disposable = splat as unknown as { dispose?: () => void };
  try {
    disposable.dispose?.();
  } catch {
    // Spark tolerates double-dispose poorly in some versions; never let
    // teardown break a world swap.
  }
}
