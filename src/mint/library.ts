import type { ModelFormat } from '../assets/model-loading';
import type { AssetTransform, ClipRole } from './registry';

const DB_NAME = 'mint-playground-library';
const DB_VERSION = 2;
const FILE_STORE = 'files';
const ASSET_STORE = 'assets';
const IMPORT_STORE = 'imports';
/** Current shape of `StoredAsset.character`. See `migrateCharactersToV2`. */
const CHARACTER_SCHEMA = 2;

/** Splat container formats Mint can export a world as. */
export const SPLAT_EXTENSIONS = ['rad', 'spz', 'ply', 'splat', 'ksplat'] as const;

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  blob: Blob;
}

/** A locomotion role, or the explicit decision not to use a clip. */
export type ClipRoleAssignment = ClipRole | 'unused';

/**
 * One animation clip, identified by its position *inside* a file rather than by
 * the file itself — a single Mint or Mixamo export routinely carries several
 * takes, and each needs its own role and its own measurements.
 *
 * The nullable analysis fields are the backwards-compatibility contract: null
 * means "never analysed", which sends `Character` back to measuring the clip at
 * load time exactly as it did before this schema existed.
 */
export interface StoredClip {
  id: string;
  fileId: string;
  fileName: string;
  /** Index into that file's `animations[]`. */
  clipIndex: number;
  clipName: string;
  role: ClipRoleAssignment;
  duration: number | null;
  /** Authored ground speed in m/s, measured at the normalized character height. */
  measuredSpeed: number | null;
  /** Fraction of tracks that bound to this character's skeleton, 0..1. */
  bindRate: number | null;
  unitScale: number | null;
  rootMotion: boolean | null;
}

export interface StoredCharacter {
  modelFileId: string;
  modelFileName: string;
  modelFormat: ModelFormat;
  /** null when never determined — resolved the next time the model loads. */
  hasSkeleton: boolean | null;
  clips: StoredClip[];
  schema: number;
}

export interface StoredAsset {
  key: string;
  kind: 'world' | 'character';
  label: string;
  createdAt: number;
  bytes: number;
  transform?: AssetTransform;
  world?: {
    fileId: string;
    fileName: string;
    colliderFileId?: string;
    colliderFileName?: string;
  };
  character?: StoredCharacter;
}

/** The pre-v2 clip record, kept only so the migration can read it. */
interface LegacyStoredClip {
  role: ClipRole;
  fileId: string;
  fileName: string;
}

export interface PendingImport {
  id: string;
  kind: 'world' | 'character';
  reference: string;
  label: string;
  createdAt: number;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Rewrites v1 characters — one clip per file, no measurements — into the
 * per-clip v2 shape.
 *
 * Everything in here is deliberately callback-only. Awaiting anything inside an
 * `onupgradeneeded` handler lets the versionchange transaction auto-commit
 * underneath you, and the migration silently half-applies.
 */
function migrateCharactersToV2(transaction: IDBTransaction): void {
  const store = transaction.objectStore(ASSET_STORE);
  store.openCursor().onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cursor) return;
    const asset = cursor.value as StoredAsset;
    const character = asset.character as (StoredCharacter & { clips: unknown[] }) | undefined;
    if (asset.kind === 'character' && character && character.schema !== CHARACTER_SCHEMA) {
      const legacy = character.clips as unknown as LegacyStoredClip[];
      character.clips = legacy.map((clip, index) => ({
        id: `${asset.key}-clip-${index}`,
        fileId: clip.fileId,
        fileName: clip.fileName,
        // v1 only ever played the first clip in a file.
        clipIndex: 0,
        clipName: stripExtension(clip.fileName),
        role: clip.role,
        duration: null,
        measuredSpeed: null,
        bindRate: null,
        unitScale: null,
        rootMotion: null,
      }));
      character.modelFormat = (fileExtension(character.modelFileName) || 'glb') as ModelFormat;
      character.hasSkeleton = null;
      character.schema = CHARACTER_SCHEMA;
      cursor.update(asset);
    }
    cursor.continue();
  };
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = (event) => {
      const db = open.result;
      const transaction = open.transaction;
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(IMPORT_STORE)) db.createObjectStore(IMPORT_STORE, { keyPath: 'id' });
      if (event.oldVersion >= 1 && event.oldVersion < 2 && transaction) {
        migrateCharactersToV2(transaction);
      }
    };
    open.onblocked = () =>
      reject(
        new Error(
          'The asset library needs to upgrade — close the playground in your other tabs and reload.',
        ),
      );
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Could not open the asset library'));
  });
  return dbPromise;
}

/**
 * Coerces a character record into the current shape in memory. The upgrade
 * handler normally does this on disk, but a blocked or interrupted upgrade can
 * leave a record behind, and a half-migrated record must not crash the catalog.
 */
function normalizeStoredAsset(asset: StoredAsset): StoredAsset {
  const character = asset.character;
  if (!character || character.schema === CHARACTER_SCHEMA) return asset;
  const legacy = (character.clips ?? []) as unknown as LegacyStoredClip[];
  return {
    ...asset,
    character: {
      modelFileId: character.modelFileId,
      modelFileName: character.modelFileName,
      modelFormat: (character.modelFormat ??
        fileExtension(character.modelFileName) ??
        'glb') as ModelFormat,
      hasSkeleton: character.hasSkeleton ?? null,
      schema: CHARACTER_SCHEMA,
      clips: legacy.map((clip, index) => ({
        id: `${asset.key}-clip-${index}`,
        fileId: clip.fileId,
        fileName: clip.fileName,
        clipIndex: 0,
        clipName: stripExtension(clip.fileName),
        role: clip.role,
        duration: null,
        measuredSpeed: null,
        bindRate: null,
        unitScale: null,
        rootMotion: null,
      })),
    },
  };
}

function makeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/** Turns a display name into a stable, readable asset key. */
export function makeAssetKey(kind: 'world' | 'character', label: string, taken: Set<string>): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'upload';
  let key = `${kind}-${slug}`;
  let suffix = 2;
  while (taken.has(key)) key = `${kind}-${slug}-${suffix++}`;
  return key;
}

export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

export function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

export function isSplatFile(name: string): boolean {
  return (SPLAT_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/**
 * Browser-side store for worlds and characters the user uploads. Assets added
 * here live only in this browser; anything imported through Mint MCP lands in
 * `mint-assets.json` instead and ships with the project.
 */
export class AssetLibrary {
  async listAssets(): Promise<StoredAsset[]> {
    const db = await openDb();
    const tx = db.transaction(ASSET_STORE, 'readonly');
    const assets = await request(tx.objectStore(ASSET_STORE).getAll() as IDBRequest<StoredAsset[]>);
    return assets.map(normalizeStoredAsset).sort((a, b) => a.createdAt - b.createdAt);
  }

  async readFileBytes(fileId: string): Promise<ArrayBuffer> {
    const db = await openDb();
    const tx = db.transaction(FILE_STORE, 'readonly');
    const file = await request(tx.objectStore(FILE_STORE).get(fileId) as IDBRequest<StoredFile | undefined>);
    if (!file) throw new Error(`Uploaded file is missing from the library: ${fileId}`);
    return file.blob.arrayBuffer();
  }

  async addWorld(label: string, splat: File, collider?: File): Promise<StoredAsset> {
    if (!isSplatFile(splat.name)) {
      throw new Error(`${splat.name} is not a splat world. Expected ${SPLAT_EXTENSIONS.join(', ')}.`);
    }
    const taken = new Set((await this.listAssets()).map((asset) => asset.key));
    const splatFile = await this.putFile(splat);
    const colliderFile = collider ? await this.putFile(collider) : undefined;
    const asset: StoredAsset = {
      key: makeAssetKey('world', label, taken),
      kind: 'world',
      label,
      createdAt: Date.now(),
      bytes: splat.size + (collider?.size ?? 0),
      world: {
        fileId: splatFile.id,
        fileName: splatFile.name,
        colliderFileId: colliderFile?.id,
        colliderFileName: colliderFile?.name,
      },
    };
    await this.putAsset(asset);
    return asset;
  }

  /**
   * The quick path: one file per role, roles already guessed from filenames.
   * Nothing here is analysed, so every measurement is stored as null and gets
   * worked out at load time.
   */
  async addCharacter(label: string, model: File, clips: StoredClipUpload[]): Promise<StoredAsset> {
    return this.addCharacterFromImport({
      label,
      model,
      modelFormat: (fileExtension(model.name) || 'glb') as ModelFormat,
      hasSkeleton: null,
      clips: clips.map((clip) => ({
        sourceFile: clip.file,
        clipIndex: 0,
        clipName: stripExtension(clip.file.name),
        role: clip.role,
        duration: null,
        measuredSpeed: null,
        bindRate: null,
        unitScale: null,
        rootMotion: null,
      })),
    });
  }

  /**
   * The guided path: any number of clips, any number of them sharing a file,
   * each already measured against this character's skeleton.
   *
   * Files are stored once no matter how many clips point at them — a six-take
   * FBX is one blob, and counting it once is also what keeps the usage figure
   * honest.
   */
  async addCharacterFromImport(draft: CharacterImportDraft): Promise<StoredAsset> {
    const taken = new Set((await this.listAssets()).map((asset) => asset.key));
    const stored = new Map<File, StoredFile>();
    const modelFile = await this.putFile(draft.model);
    stored.set(draft.model, modelFile);

    const storedClips: StoredClip[] = [];
    for (const [index, clip] of draft.clips.entries()) {
      let file = stored.get(clip.sourceFile);
      if (!file) {
        file = await this.putFile(clip.sourceFile);
        stored.set(clip.sourceFile, file);
      }
      storedClips.push({
        id: makeId('clip'),
        fileId: file.id,
        fileName: file.name,
        clipIndex: clip.clipIndex,
        clipName: clip.clipName || `Clip ${index + 1}`,
        role: clip.role,
        duration: clip.duration,
        measuredSpeed: clip.measuredSpeed,
        bindRate: clip.bindRate,
        unitScale: clip.unitScale,
        rootMotion: clip.rootMotion,
      });
    }

    let bytes = 0;
    for (const file of stored.values()) bytes += file.size;

    const asset: StoredAsset = {
      key: makeAssetKey('character', draft.label, taken),
      kind: 'character',
      label: draft.label,
      createdAt: Date.now(),
      bytes,
      character: {
        modelFileId: modelFile.id,
        modelFileName: modelFile.name,
        modelFormat: draft.modelFormat,
        hasSkeleton: draft.hasSkeleton,
        clips: storedClips,
        schema: CHARACTER_SCHEMA,
      },
    };
    await this.putAsset(asset);
    return asset;
  }

  async renameAsset(key: string, label: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(ASSET_STORE, 'readwrite');
    const store = tx.objectStore(ASSET_STORE);
    const asset = await request(store.get(key) as IDBRequest<StoredAsset | undefined>);
    if (asset) {
      asset.label = label;
      store.put(asset);
    }
    await done(tx);
  }

  async removeAsset(key: string): Promise<void> {
    const db = await openDb();
    const readTx = db.transaction(ASSET_STORE, 'readonly');
    const asset = await request(
      readTx.objectStore(ASSET_STORE).get(key) as IDBRequest<StoredAsset | undefined>,
    );
    if (!asset) return;

    // Deduped: several clips routinely share one multi-take file.
    const fileIds = new Set(
      [
        asset.world?.fileId,
        asset.world?.colliderFileId,
        asset.character?.modelFileId,
        ...(asset.character?.clips.map((clip) => clip.fileId) ?? []),
      ].filter((id): id is string => Boolean(id)),
    );

    const tx = db.transaction([ASSET_STORE, FILE_STORE], 'readwrite');
    tx.objectStore(ASSET_STORE).delete(key);
    for (const id of fileIds) tx.objectStore(FILE_STORE).delete(id);
    await done(tx);
  }

  async listImports(): Promise<PendingImport[]> {
    const db = await openDb();
    const tx = db.transaction(IMPORT_STORE, 'readonly');
    const imports = await request(
      tx.objectStore(IMPORT_STORE).getAll() as IDBRequest<PendingImport[]>,
    );
    return imports.sort((a, b) => a.createdAt - b.createdAt);
  }

  async addImport(kind: 'world' | 'character', reference: string, label: string): Promise<PendingImport> {
    const record: PendingImport = {
      id: makeId('import'),
      kind,
      reference,
      label,
      createdAt: Date.now(),
    };
    const db = await openDb();
    const tx = db.transaction(IMPORT_STORE, 'readwrite');
    tx.objectStore(IMPORT_STORE).put(record);
    await done(tx);
    return record;
  }

  async removeImport(id: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(IMPORT_STORE, 'readwrite');
    tx.objectStore(IMPORT_STORE).delete(id);
    await done(tx);
  }

  async usage(): Promise<{ used: number; quota: number | null }> {
    const assets = await this.listAssets();
    const used = assets.reduce((sum, asset) => sum + asset.bytes, 0);
    let quota: number | null = null;
    if (navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        quota = estimate.quota ?? null;
      } catch {
        quota = null;
      }
    }
    return { used, quota };
  }

  private async putFile(file: File): Promise<StoredFile> {
    const record: StoredFile = {
      id: makeId('file'),
      name: file.name,
      size: file.size,
      blob: file,
    };
    const db = await openDb();
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put(record);
    await done(tx);
    return record;
  }

  private async putAsset(asset: StoredAsset): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(ASSET_STORE, 'readwrite');
    tx.objectStore(ASSET_STORE).put(asset);
    await done(tx);
  }
}

export interface StoredClipUpload {
  role: ClipRole;
  file: File;
}

/** One reviewed clip on its way into the library. */
export interface CharacterImportClip {
  sourceFile: File;
  clipIndex: number;
  clipName: string;
  role: ClipRoleAssignment;
  duration: number | null;
  measuredSpeed: number | null;
  bindRate: number | null;
  unitScale: number | null;
  rootMotion: boolean | null;
}

export interface CharacterImportDraft {
  label: string;
  model: File;
  modelFormat: ModelFormat;
  hasSkeleton: boolean | null;
  clips: CharacterImportClip[];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
