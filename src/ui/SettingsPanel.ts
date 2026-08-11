import {
  AssetLibrary,
  fileExtension,
  formatBytes,
  isSplatFile,
  SPLAT_EXTENSIONS,
  type PendingImport,
  type StoredAsset,
  type StoredClipUpload,
} from '../mint/library';
import { assignClipRolesByName, type ClipRole } from '../mint/registry';

type Status = 'idle' | 'busy' | 'error' | 'done';

/**
 * Upload and management UI. Worlds arrive as Mint splat exports (RAD/SPZ/PLY),
 * characters as rigged GLBs plus their animation clip GLBs. Anything that has
 * to go through Mint itself — importing a world by link, or rigging a character
 * that has no walk cycle — is queued here as a request to hand to Claude,
 * because Mint's API is not reachable from the browser.
 */
export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly openButton: HTMLElement;
  private readonly closeButton: HTMLElement;
  private readonly assetList: HTMLElement;
  private readonly importList: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly usageEl: HTMLElement;
  private readonly worldInput: HTMLInputElement;
  private readonly characterInput: HTMLInputElement;
  private readonly linkInput: HTMLInputElement;
  private readonly linkKind: HTMLSelectElement;

  /** Raised after the library changes so the game can rebuild its catalog. */
  onLibraryChanged: () => void | Promise<void> = () => {};

  constructor(private readonly library: AssetLibrary) {
    this.root = requireElement('#settings-panel');
    this.openButton = requireElement('#settings-open');
    this.closeButton = requireElement('#settings-close');
    this.assetList = requireElement('#settings-assets');
    this.importList = requireElement('#settings-imports');
    this.statusEl = requireElement('#settings-status');
    this.usageEl = requireElement('#settings-usage');
    this.worldInput = requireElement<HTMLInputElement>('#upload-world');
    this.characterInput = requireElement<HTMLInputElement>('#upload-character');
    this.linkInput = requireElement<HTMLInputElement>('#import-link');
    this.linkKind = requireElement<HTMLSelectElement>('#import-kind');

    this.openButton.addEventListener('click', this.onOpen);
    this.closeButton.addEventListener('click', this.onClose);
    this.worldInput.addEventListener('change', this.onWorldFiles);
    this.characterInput.addEventListener('change', this.onCharacterFiles);
    requireElement('#import-queue').addEventListener('click', this.onQueueImport);
  }

  private readonly onOpen = () => {
    this.root.classList.remove('is-hidden');
    void this.refresh();
  };

  private readonly onClose = () => {
    this.root.classList.add('is-hidden');
  };

  private readonly onWorldFiles = () => {
    const files = [...(this.worldInput.files ?? [])];
    this.worldInput.value = '';
    if (files.length === 0) return;
    void this.addWorld(files);
  };

  private readonly onCharacterFiles = () => {
    const files = [...(this.characterInput.files ?? [])];
    this.characterInput.value = '';
    if (files.length === 0) return;
    void this.addCharacter(files);
  };

  private readonly onQueueImport = () => {
    const reference = this.linkInput.value.trim();
    if (!reference) {
      this.setStatus('Paste a mint.gg link or asset ID first.', 'error');
      return;
    }
    const kind = this.linkKind.value === 'world' ? 'world' : 'character';
    void this.queueImport(kind, reference);
  };

  get isOpen(): boolean {
    return !this.root.classList.contains('is-hidden');
  }

  toggle(): void {
    if (this.isOpen) this.onClose();
    else this.onOpen();
  }

  setHidden(hidden: boolean): void {
    this.openButton.classList.toggle('is-hidden', hidden);
    if (hidden) this.onClose();
  }

  private async addWorld(files: File[]): Promise<void> {
    const splat = files.find((file) => isSplatFile(file.name));
    if (!splat) {
      this.setStatus(
        `Pick a Mint world export (${SPLAT_EXTENSIONS.join(', ')}).`,
        'error',
      );
      return;
    }
    const collider = files.find((file) => fileExtension(file.name) === 'glb');
    this.setStatus(`Storing ${splat.name}…`, 'busy');
    try {
      const label = prettyLabel(splat.name);
      const asset = await this.library.addWorld(label, splat, collider);
      await this.onLibraryChanged();
      await this.refresh();
      this.setStatus(
        collider
          ? `Added "${asset.label}" with its collider.`
          : `Added "${asset.label}". It has no collider, so the ground is read from the splats.`,
        'done',
      );
    } catch (error) {
      this.setStatus(errorMessage(error), 'error');
    }
  }

  private async addCharacter(files: File[]): Promise<void> {
    const glbs = files.filter((file) => fileExtension(file.name) === 'glb');
    if (glbs.length === 0) {
      this.setStatus('Pick the rigged character GLB, and its clip GLBs if you have them.', 'error');
      return;
    }

    // Mint names the rigged mesh "…-rigged.glb" and the clips after their
    // motion, so the largest non-clip GLB is the character when in doubt.
    const roles = assignClipRolesByName(glbs, (file) => file.name);
    const explicitModel = glbs.find((file) => /rigged|character|model/i.test(file.name));
    const model =
      explicitModel ??
      glbs.filter((file) => !roles.has(file)).sort((a, b) => b.size - a.size)[0] ??
      glbs[0];

    const clips: StoredClipUpload[] = [];
    for (const [file, role] of roles) {
      if (file === model) continue;
      clips.push({ role: role as ClipRole, file });
    }

    this.setStatus(`Storing ${model.name}…`, 'busy');
    try {
      const asset = await this.library.addCharacter(prettyLabel(model.name), model, clips);
      await this.onLibraryChanged();
      await this.refresh();
      const missing = (['walk', 'run', 'jump'] as ClipRole[]).filter(
        (role) => !clips.some((clip) => clip.role === role),
      );
      this.setStatus(
        missing.length === 0
          ? `Added "${asset.label}" with walk, run and jump.`
          : `Added "${asset.label}", missing ${missing.join(', ')}. Queue a Mint rig below to animate it.`,
        'done',
      );
    } catch (error) {
      this.setStatus(errorMessage(error), 'error');
    }
  }

  private async queueImport(kind: 'world' | 'character', reference: string): Promise<void> {
    try {
      await this.library.addImport(kind, reference, prettyLabel(reference));
      this.linkInput.value = '';
      await this.refresh();
      this.setStatus('Queued. Use "Copy request" and paste it to Claude.', 'done');
    } catch (error) {
      this.setStatus(errorMessage(error), 'error');
    }
  }

  async refresh(): Promise<void> {
    const [assets, imports, usage] = await Promise.all([
      this.library.listAssets(),
      this.library.listImports(),
      this.library.usage(),
    ]);
    this.renderAssets(assets);
    this.renderImports(imports);
    this.usageEl.textContent =
      assets.length === 0
        ? 'Nothing uploaded yet. Built-in assets come from mint-assets.json.'
        : `${assets.length} uploaded · ${formatBytes(usage.used)} in this browser`;
  }

  private renderAssets(assets: StoredAsset[]): void {
    this.assetList.innerHTML = '';
    if (assets.length === 0) return;

    for (const asset of assets) {
      const row = document.createElement('li');
      row.className = 'settings-row';

      const name = document.createElement('span');
      name.className = 'settings-row-name';
      const detail =
        asset.kind === 'world'
          ? asset.world?.colliderFileId
            ? 'world · collider'
            : 'world · splat ground'
          : `character · ${asset.character?.clips.map((clip) => clip.role).join(', ') || 'idle only'}`;
      name.textContent = `${asset.label} — ${detail} · ${formatBytes(asset.bytes)}`;
      row.append(name);

      row.append(
        this.rowButton('Rename', async () => {
          const next = window.prompt('New name', asset.label);
          if (!next) return;
          await this.library.renameAsset(asset.key, next.trim());
          await this.onLibraryChanged();
          await this.refresh();
        }),
      );
      row.append(
        this.rowButton('Delete', async () => {
          if (!window.confirm(`Delete "${asset.label}" from this browser?`)) return;
          await this.library.removeAsset(asset.key);
          await this.onLibraryChanged();
          await this.refresh();
          this.setStatus(`Deleted "${asset.label}".`, 'done');
        }),
      );
      this.assetList.append(row);
    }
  }

  private renderImports(imports: PendingImport[]): void {
    this.importList.innerHTML = '';
    for (const record of imports) {
      const item = document.createElement('li');
      item.className = 'settings-import';

      const row = document.createElement('div');
      row.className = 'settings-row';

      const name = document.createElement('span');
      name.className = 'settings-row-name';
      name.textContent = `${record.kind} · ${record.reference}`;
      row.append(name);

      // The text is always on screen and selectable, so copying never depends
      // on clipboard permissions being granted.
      const request = document.createElement('code');
      request.className = 'settings-request';
      request.textContent = importRequestText(record);

      row.append(
        this.rowButton('Copy request', async () => {
          const copied = await copyText(request.textContent ?? '');
          if (copied) this.setStatus('Request copied. Paste it to Claude in chat.', 'done');
          else {
            selectText(request);
            this.setStatus('Select the highlighted text below and copy it.', 'idle');
          }
        }),
      );
      row.append(
        this.rowButton('Remove', async () => {
          await this.library.removeImport(record.id);
          await this.refresh();
        }),
      );

      item.append(row, request);
      this.importList.append(item);
    }
  }

  private rowButton(label: string, action: () => Promise<void>): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-row-action';
    button.textContent = label;
    button.addEventListener('click', () => {
      void action().catch((error) => this.setStatus(errorMessage(error), 'error'));
    });
    return button;
  }

  private setStatus(text: string, status: Status): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.state = status;
  }

  dispose(): void {
    this.openButton.removeEventListener('click', this.onOpen);
    this.closeButton.removeEventListener('click', this.onClose);
    this.worldInput.removeEventListener('change', this.onWorldFiles);
    this.characterInput.removeEventListener('change', this.onCharacterFiles);
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function selectText(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function importRequestText(record: PendingImport): string {
  return record.kind === 'world'
    ? `Import this Mint world into the splat playground and sync it into mint-assets.json: ${record.reference}`
    : `Import this Mint character into the splat playground: ${record.reference}. Rig it with the natural locomotion clips (idle 0, walking_2 692, lean forward sprint 644, regular jump 466) if it has no walk cycle, then sync it into mint-assets.json.`;
}

function prettyLabel(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b(rigged|inplace|glb)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireElement<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
