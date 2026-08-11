import type { AssetTransform, ClipRole } from './registry';

const DB_NAME = 'mint-playground-library';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const ASSET_STORE = 'assets';
const IMPORT_STORE = 'imports';

/** Splat container formats Mint can export a world as. */
export const SPLAT_EXTENSIONS = ['rad', 'spz', 'ply', 'splat', 'ksplat'] as const;

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  blob: Blob;
}

export interface StoredClip {
  role: ClipRole;
  fileId: string;
  fileName: string;
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
  character?: {
    modelFileId: string;
    modelFileName: string;
    clips: StoredClip[];
  };
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

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(IMPORT_STORE)) db.createObjectStore(IMPORT_STORE, { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Could not open the asset library'));
  });
  return dbPromise;
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
    return assets.sort((a, b) => a.createdAt - b.createdAt);
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

  async addCharacter(label: string, model: File, clips: StoredClipUpload[]): Promise<StoredAsset> {
    const taken = new Set((await this.listAssets()).map((asset) => asset.key));
    const modelFile = await this.putFile(model);
    const storedClips: StoredClip[] = [];
    let bytes = model.size;
    for (const clip of clips) {
      const stored = await this.putFile(clip.file);
      storedClips.push({ role: clip.role, fileId: stored.id, fileName: stored.name });
      bytes += clip.file.size;
    }
    const asset: StoredAsset = {
      key: makeAssetKey('character', label, taken),
      kind: 'character',
      label,
      createdAt: Date.now(),
      bytes,
      character: {
        modelFileId: modelFile.id,
        modelFileName: modelFile.name,
        clips: storedClips,
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

    const fileIds = [
      asset.world?.fileId,
      asset.world?.colliderFileId,
      asset.character?.modelFileId,
      ...(asset.character?.clips.map((clip) => clip.fileId) ?? []),
    ].filter((id): id is string => Boolean(id));

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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
