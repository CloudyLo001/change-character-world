import registryRaw from '../../mint-assets.json?raw';
import type { StoredAsset } from './library';

export type Vec3 = [number, number, number];

export interface AssetTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/** Where an entry came from: the project registry, or this browser's uploads. */
export type AssetSource = 'registry' | 'library';

/** A file held in the browser asset library, resolved to bytes on demand. */
export interface LibraryFileRef {
  fileId: string;
  fileName: string;
}

export interface WorldEntry {
  key: string;
  label: string;
  source: AssetSource;
  /** Remote Mint CDN RAD stream. Absent for uploaded splat files. */
  runtimeUrl?: string;
  /** Invisible collision mesh. Absent when the world is an uploaded splat file. */
  colliderUrl?: string;
  /** Uploaded splat container (rad/spz/ply) held in the library. */
  splatFile?: LibraryFileRef;
  /** Optional uploaded collider GLB. */
  colliderFile?: LibraryFileRef;
  transform: AssetTransform;
  thumbnailUrl?: string;
}

export interface CharacterClips {
  idle?: string;
  walk?: string;
  run?: string;
  jump?: string;
}

export type ClipRole = keyof CharacterClips;

export type ClipFileRefs = Partial<Record<ClipRole, LibraryFileRef>>;

/**
 * One clip inside an uploaded file, already reviewed and measured. Several refs
 * routinely share a `fileId` — a Mint animation batch or a Mixamo pack exports
 * as a single file holding every take.
 */
export interface CharacterClipRef extends LibraryFileRef {
  role: ClipRole;
  /** Index into that file's `animations[]`. */
  clipIndex: number;
  clipName?: string;
  /** Authored ground speed in m/s at the normalized character height. */
  measuredSpeed?: number;
  bindRate?: number;
  duration?: number;
}

export interface CharacterEntry {
  key: string;
  label: string;
  source: AssetSource;
  /** Project-served GLB URL. Absent for uploaded characters. */
  modelUrl?: string;
  clips: CharacterClips;
  /** Uploaded rigged model held in the library. */
  modelFile?: LibraryFileRef;
  /** Legacy one-file-per-role refs. Superseded by `clipRefs` when present. */
  clipFiles?: ClipFileRefs;
  /** Per-clip refs from the guided importer; preferred over `clipFiles`. */
  clipRefs?: CharacterClipRef[];
  modelFormat?: string;
  /** False for a mesh with no skeleton, which nothing can animate. */
  playable?: boolean;
  transform: AssetTransform;
  thumbnailUrl?: string;
}

export interface Catalog {
  worlds: WorldEntry[];
  characters: CharacterEntry[];
}

interface RegistryArtifact {
  artifactId: string;
  role?: string;
  localPath?: string;
  filename?: string;
}

interface RegistryAsset {
  source?: { assetType?: string; assetId?: string };
  transform?: Partial<AssetTransform>;
  mode?: string;
  runtime?: {
    runtimeUrl?: string;
    collider?: { runtimeUrl?: string };
  };
  artifacts?: Record<string, RegistryArtifact>;
  thumbnailUrl?: string;
}

interface Registry {
  assets?: Record<string, RegistryAsset>;
}

// Production display calibration for World Labs splat output; applied to the
// shared splat+collider root whenever the registry transform is left identity.
export const WORLD_CALIBRATION: AssetTransform = {
  position: [0, 1.5, 0],
  rotation: [Math.PI, Math.PI, 0],
  scale: [2.5, 2.5, 2.5],
};

const IDENTITY: AssetTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

function asVec3(value: unknown, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number')) {
    return [value[0], value[1], value[2]];
  }
  return fallback;
}

function normalizeTransform(raw: Partial<AssetTransform> | undefined): AssetTransform {
  return {
    position: asVec3(raw?.position, IDENTITY.position),
    rotation: asVec3(raw?.rotation, IDENTITY.rotation),
    scale: asVec3(raw?.scale, IDENTITY.scale),
  };
}

function isIdentity(transform: AssetTransform): boolean {
  return (
    transform.position.every((n) => n === 0) &&
    transform.rotation.every((n) => n === 0) &&
    transform.scale.every((n) => n === 1)
  );
}

/**
 * `public/assets/mint/...` registry paths become browser URLs. They are
 * prefixed with the deploy base so the build also works when the site is
 * served from a subpath, as it is on GitHub Pages.
 */
function toBrowserUrl(localPath: string): string {
  const normalized = localPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const relative = normalized.startsWith('public/')
    ? normalized.slice('public/'.length)
    : normalized;
  return `${import.meta.env.BASE_URL}${relative}`;
}

function labelFromKey(key: string): string {
  return key
    .replace(/^(world|character)-/, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Per-role pattern lists in preference order: a batch may carry alternate
// walk/run clips, and the first pattern that matches any artifact wins.
const ROLE_PATTERNS: Array<{ role: ClipRole; patterns: RegExp[] }> = [
  { role: 'jump', patterns: [/leap/i, /jump/i] },
  { role: 'run', patterns: [/sprint/i, /charge/i, /run/i] },
  { role: 'walk', patterns: [/walking[-_]2/i, /strut|stylish/i, /walk/i] },
  { role: 'idle', patterns: [/idle/i] },
];

/** Confidence given to a role's preferred pattern, and to its alternates. */
const PRIMARY_NAME_SCORE = 1;
const ALTERNATE_NAME_SCORE = 0.8;

/**
 * How strongly a name reads as each locomotion role. The clip classifier scores
 * a clip's internal name and its filename separately and weighs them against
 * measured motion, so it needs the graded signal rather than a single winner.
 *
 * Backed by the same pattern table `assignClipRolesByName` uses, so the two can
 * never drift apart.
 */
export function scoreNameForRoles(name: string): Partial<Record<ClipRole, number>> {
  // Turn clips also contain "idle" (Idle_Turn_Left); never map them.
  if (/turn/i.test(name)) return {};
  const scores: Partial<Record<ClipRole, number>> = {};
  for (const { role, patterns } of ROLE_PATTERNS) {
    for (let i = 0; i < patterns.length; i += 1) {
      if (patterns[i].test(name)) {
        scores[role] = i === 0 ? PRIMARY_NAME_SCORE : ALTERNATE_NAME_SCORE;
        break;
      }
    }
  }
  return scores;
}

/**
 * Maps clip names onto locomotion roles. Shared by the project registry and the
 * uploader so a folder of Mint clip GLBs is read the same way in both paths.
 */
export function assignClipRolesByName<T>(items: T[], nameOf: (item: T) => string): Map<T, ClipRole> {
  // Turn clips also contain "idle" (Idle_Turn_Left); never map them.
  const candidates = items.filter((item) => !/turn/i.test(nameOf(item)));
  const assigned = new Map<T, ClipRole>();
  const used = new Set<T>();
  for (const { role, patterns } of ROLE_PATTERNS) {
    outer: for (const pattern of patterns) {
      for (const item of candidates) {
        if (used.has(item)) continue;
        if (pattern.test(nameOf(item))) {
          assigned.set(item, role);
          used.add(item);
          break outer;
        }
      }
    }
  }
  return assigned;
}

function assignClipRoles(artifacts: RegistryArtifact[]): Map<RegistryArtifact, ClipRole> {
  const clipArtifacts = artifacts.filter(
    (a) => a.role === 'animation_clip' && a.localPath?.toLowerCase().endsWith('.glb'),
  );
  return assignClipRolesByName(clipArtifacts, (a) => `${a.artifactId} ${a.filename ?? ''}`);
}

export function loadCatalog(): Catalog {
  const registry = JSON.parse(registryRaw) as Registry;
  const worlds: WorldEntry[] = [];
  const characters: CharacterEntry[] = [];

  for (const [key, asset] of Object.entries(registry.assets ?? {})) {
    const transform = normalizeTransform(asset.transform);
    const thumbnailUrl = asset.thumbnailUrl ? toBrowserUrl(asset.thumbnailUrl) : undefined;

    if (asset.source?.assetType === 'world' && asset.mode === 'remote_stream') {
      const runtimeUrl = asset.runtime?.runtimeUrl;
      const colliderUrl = asset.runtime?.collider?.runtimeUrl;
      if (!runtimeUrl || !colliderUrl) {
        console.warn(`Skipping world "${key}": missing RAD runtime or collider URL.`);
        continue;
      }
      worlds.push({
        key,
        label: labelFromKey(key),
        source: 'registry',
        runtimeUrl,
        colliderUrl,
        transform: isIdentity(transform) ? WORLD_CALIBRATION : transform,
        thumbnailUrl,
      });
      continue;
    }

    const artifacts = Object.values(asset.artifacts ?? {});
    const rigged = artifacts.find((a) => a.role === 'rigged_character' && a.localPath);
    if (rigged?.localPath) {
      const clips: CharacterClips = {};
      for (const [artifact, role] of assignClipRoles(artifacts)) {
        if (artifact.localPath) clips[role] = toBrowserUrl(artifact.localPath);
      }
      characters.push({
        key,
        label: labelFromKey(key),
        source: 'registry',
        modelUrl: toBrowserUrl(rigged.localPath),
        clips,
        transform,
        thumbnailUrl,
      });
    }
  }

  worlds.sort((a, b) => a.label.localeCompare(b.label));
  characters.sort((a, b) => a.label.localeCompare(b.label));
  return { worlds, characters };
}

/** Turns uploaded library records into catalog entries and appends them. */
export function mergeLibraryAssets(base: Catalog, assets: StoredAsset[]): Catalog {
  const worlds = [...base.worlds];
  const characters = [...base.characters];

  for (const asset of assets) {
    if (asset.kind === 'world' && asset.world) {
      worlds.push({
        key: asset.key,
        label: asset.label,
        source: 'library',
        splatFile: { fileId: asset.world.fileId, fileName: asset.world.fileName },
        colliderFile: asset.world.colliderFileId
          ? { fileId: asset.world.colliderFileId, fileName: asset.world.colliderFileName ?? '' }
          : undefined,
        transform: asset.transform ?? WORLD_CALIBRATION,
      });
      continue;
    }
    if (asset.kind === 'character' && asset.character) {
      const clipRefs: CharacterClipRef[] = [];
      const clipFiles: ClipFileRefs = {};
      for (const clip of asset.character.clips) {
        if (clip.role === 'unused') continue;
        clipRefs.push({
          fileId: clip.fileId,
          fileName: clip.fileName,
          role: clip.role,
          clipIndex: clip.clipIndex,
          clipName: clip.clipName,
          measuredSpeed: clip.measuredSpeed ?? undefined,
          bindRate: clip.bindRate ?? undefined,
          duration: clip.duration ?? undefined,
        });
        // Kept in step so anything still reading the one-file-per-role shape
        // sees what it always saw.
        if (clip.clipIndex === 0 && !clipFiles[clip.role]) {
          clipFiles[clip.role] = { fileId: clip.fileId, fileName: clip.fileName };
        }
      }
      characters.push({
        key: asset.key,
        label: asset.label,
        source: 'library',
        clips: {},
        modelFile: {
          fileId: asset.character.modelFileId,
          fileName: asset.character.modelFileName,
        },
        clipFiles,
        clipRefs,
        modelFormat: asset.character.modelFormat,
        // null means "not determined yet"; only an explicit false is a promise
        // that this mesh cannot be animated.
        playable: asset.character.hasSkeleton !== false,
        transform: asset.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      });
    }
  }

  worlds.sort((a, b) => a.label.localeCompare(b.label));
  characters.sort((a, b) => a.label.localeCompare(b.label));
  return { worlds, characters };
}
