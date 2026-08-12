import * as THREE from 'three';
import { createMintGltfLoader } from './gltf-runtime';

/**
 * Format-agnostic model loading. Everything the character importer accepts
 * resolves through here to the same `{ scene, animations }` shape, so callers
 * never branch on file type.
 *
 * Only GLTF is bundled eagerly — it is what Mint exports and what
 * `mint-assets.json` serves. The other loaders are behind dynamic imports so a
 * user who never touches FBX never downloads it.
 */

export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl';

export const MODEL_EXTENSIONS: readonly ModelFormat[] = ['glb', 'gltf', 'fbx', 'obj', 'stl'];

/** Extensions the file picker should offer, as an `accept` attribute value. */
export const MODEL_ACCEPT = MODEL_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  format: ModelFormat;
}

/** Extra files picked alongside the model, keyed by their bare filename. */
export type Sidecars = Map<string, Blob>;

const FALLBACK_COLOR = 0xb9bcc6;

export function modelFormatOf(name: string): ModelFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  const ext = match ? (match[1].toLowerCase() as ModelFormat) : null;
  return ext && MODEL_EXTENSIONS.includes(ext) ? ext : null;
}

export function isModelFile(name: string): boolean {
  return modelFormatOf(name) !== null;
}

/**
 * Yields to the event loop. FBX parsing is synchronous and can run for a
 * second or more on a large rig, so the UI gets a chance to paint its
 * "Parsing…" state either side of the call.
 */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

/**
 * Resolves relative references (a .gltf's .bin, an .obj's .mtl, an FBX's
 * textures) against files the user picked in the same selection, by basename.
 */
function sidecarManager(sidecars: Sidecars | undefined): {
  manager: THREE.LoadingManager;
  revoke: () => void;
} {
  const manager = new THREE.LoadingManager();
  const urls: string[] = [];
  if (sidecars && sidecars.size > 0) {
    const byName = new Map<string, Blob>();
    for (const [name, blob] of sidecars) byName.set(baseName(name).toLowerCase(), blob);
    const cache = new Map<string, string>();
    manager.setURLModifier((url) => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return url;
      const key = baseName(decodeURIComponent(url)).toLowerCase();
      const blob = byName.get(key);
      if (!blob) return url;
      let objectUrl = cache.get(key);
      if (!objectUrl) {
        objectUrl = URL.createObjectURL(blob);
        cache.set(key, objectUrl);
        urls.push(objectUrl);
      }
      return objectUrl;
    });
  }
  return {
    manager,
    revoke: () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.length = 0;
    },
  };
}

/** A GLB is self-contained; a .gltf may point at files we were not given. */
function assertGltfSelfContained(bytes: ArrayBuffer, fileName: string, sidecars?: Sidecars): void {
  let json: { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return; // Not JSON — the binary path will produce its own error.
  }
  const known = new Set<string>();
  if (sidecars) for (const name of sidecars.keys()) known.add(baseName(name).toLowerCase());
  const missing = [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((entry) => entry.uri)
    .filter((uri): uri is string => Boolean(uri) && !uri!.startsWith('data:'))
    .map((uri) => baseName(decodeURIComponent(uri)))
    .filter((name) => !known.has(name.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(
      `${fileName} references files that were not uploaded (${[...new Set(missing)].join(', ')}). ` +
        'Select them alongside it, or export a single .glb instead.',
    );
  }
}

/** Replaces whatever a mesh-only loader produced with a lit standard material. */
function applyFallbackMaterial(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = new THREE.MeshStandardMaterial({
      color: FALLBACK_COLOR,
      roughness: 0.8,
      metalness: 0.05,
    });
    const previous = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const old of previous) old?.dispose?.();
    mesh.material = material;
  });
}

function asGroup(object: THREE.Object3D): THREE.Group {
  if ((object as THREE.Group).isGroup) return object as THREE.Group;
  const group = new THREE.Group();
  group.add(object);
  return group;
}

async function parseGltf(bytes: ArrayBuffer, format: ModelFormat, sidecars?: Sidecars) {
  const { manager, revoke } = sidecarManager(sidecars);
  const loader = createMintGltfLoader({ manager });
  try {
    const gltf = await loader.parseAsync(bytes, '');
    return { scene: gltf.scene, animations: gltf.animations, format };
  } finally {
    revoke();
  }
}

async function parseFbx(bytes: ArrayBuffer, sidecars?: Sidecars): Promise<LoadedModel> {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const { manager, revoke } = sidecarManager(sidecars);
  await yieldToUi();
  try {
    const group = new FBXLoader(manager).parse(bytes, '');
    // FBXLoader hangs animations off whichever object it returns; when a scene
    // collapses to a single child it can end up on that child instead.
    const animations =
      group.animations?.length > 0
        ? group.animations
        : (group.children[0]?.animations ?? []);
    return { scene: asGroup(group), animations, format: 'fbx' };
  } finally {
    revoke();
    await yieldToUi();
  }
}

async function parseObj(bytes: ArrayBuffer, sidecars?: Sidecars): Promise<LoadedModel> {
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
  const text = new TextDecoder().decode(bytes);
  const { manager, revoke } = sidecarManager(sidecars);
  try {
    const loader = new OBJLoader(manager);
    const mtlName = /^mtllib\s+(.+)$/im.exec(text)?.[1]?.trim();
    if (mtlName && sidecars) {
      const mtlBlob = [...sidecars.entries()].find(
        ([name]) => baseName(name).toLowerCase() === baseName(mtlName).toLowerCase(),
      )?.[1];
      if (mtlBlob) {
        const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
        const materials = new MTLLoader(manager).parse(await mtlBlob.text(), '');
        materials.preload();
        loader.setMaterials(materials);
        const group = loader.parse(text);
        return { scene: asGroup(group), animations: [], format: 'obj' };
      }
    }
    const group = loader.parse(text);
    // Without an MTL the loader leaves a flat white Phong material behind,
    // which the scene's environment lighting cannot touch.
    applyFallbackMaterial(group);
    return { scene: asGroup(group), animations: [], format: 'obj' };
  } finally {
    revoke();
  }
}

async function parseStl(bytes: ArrayBuffer): Promise<LoadedModel> {
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const geometry = new STLLoader().parse(bytes);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: FALLBACK_COLOR, roughness: 0.8, metalness: 0.05 }),
  );
  const group = new THREE.Group();
  group.add(mesh);
  return { scene: group, animations: [], format: 'stl' };
}

/** Parses bytes already in hand — an upload, or a file read back from the library. */
export async function loadModelBytes(
  bytes: ArrayBuffer,
  fileName: string,
  sidecars?: Sidecars,
): Promise<LoadedModel> {
  const format = modelFormatOf(fileName);
  if (!format) {
    throw new Error(
      `${fileName} is not a model file. Expected ${MODEL_EXTENSIONS.join(', ').toUpperCase()}.`,
    );
  }
  switch (format) {
    case 'glb':
      return parseGltf(bytes, 'glb', sidecars);
    case 'gltf':
      assertGltfSelfContained(bytes, fileName, sidecars);
      return parseGltf(bytes, 'gltf', sidecars);
    case 'fbx':
      return parseFbx(bytes, sidecars);
    case 'obj':
      return parseObj(bytes, sidecars);
    case 'stl':
      return parseStl(bytes);
  }
}

/** Fetches and parses a project-served model URL. */
export async function loadModelUrl(url: string): Promise<LoadedModel> {
  const format = modelFormatOf(url.split(/[?#]/)[0]);
  // Registry assets are always GLTF; going through the loader keeps its
  // progress handling and Draco setup rather than fetching by hand.
  if (!format || format === 'glb' || format === 'gltf') {
    const gltf = await createMintGltfLoader().loadAsync(url);
    return { scene: gltf.scene, animations: gltf.animations, format: format ?? 'glb' };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${url} (${response.status}).`);
  return loadModelBytes(await response.arrayBuffer(), url.split(/[?#]/)[0]);
}
