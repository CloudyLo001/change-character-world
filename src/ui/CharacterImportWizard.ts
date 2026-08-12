import * as THREE from 'three';
import {
  classifyClips,
  meaningfulClipName,
  ROLES,
  type ClipCandidate,
  type RoleAssignment,
} from '../animation/clip-classify';
import {
  collectBoneNames,
  collectBones,
  prepareUploadedClip,
  MIN_CLIP_BINDING,
  type PreparedClip,
  type RetargetTarget,
} from '../animation/clip-fit';
import { ClipHarness, cloneSkinned, TARGET_HEIGHT, type ClipMetrics } from '../animation/ClipHarness';
import {
  loadModelBytes,
  modelFormatOf,
  yieldToUi,
  MODEL_ACCEPT,
  type LoadedModel,
  type ModelFormat,
} from '../assets/model-loading';
import { disposeObject3D } from '../utils/dispose';
import { AssetLibrary, stripExtension, type CharacterImportClip } from '../mint/library';
import { ClipPreview } from './ClipPreview';

type Step = 'model' | 'clips' | 'review';
type Status = 'idle' | 'busy' | 'error' | 'done';

interface ClipRow {
  id: string;
  sourceFile: File;
  fileName: string;
  clipIndex: number;
  clipName: string;
  clipsInFile: number;
  raw: THREE.AnimationClip;
  prepared?: PreparedClip;
  metrics?: ClipMetrics;
  role: RoleAssignment;
}

/**
 * Guided import for a character plus however many animation files it came with.
 *
 * Guessing a role per file from its filename — which is all this used to do —
 * falls apart on the workflow it exists for: a rigged model plus a batch of
 * clips generated in Mint, where one file routinely holds several takes and the
 * names are as likely to be `anim_01` as `walking`. So this parses every clip in
 * every file, measures what each one actually does on *this* skeleton, proposes
 * an assignment, and then shows the user the evidence before anything is
 * written.
 */
export class CharacterImportWizard {
  private readonly root: HTMLElement;
  private readonly openButton: HTMLElement;
  private readonly closeButton: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly modelInput: HTMLInputElement;
  private readonly clipsInput: HTMLInputElement;

  private step: Step = 'model';
  private label = '';
  private modelFile: File | null = null;
  private modelFormat: ModelFormat = 'glb';
  private modelSource: LoadedModel | null = null;
  private target: RetargetTarget | null = null;
  private boneCount = 0;
  private triangleCount = 0;
  private rows: ClipRow[] = [];
  private analysed = false;

  private preview: ClipPreview | null = null;
  private harness: ClipHarness | null = null;
  private selectedRow: string | null = null;

  /** Raised after the library changes so the game can rebuild its catalog. */
  onLibraryChanged: () => void | Promise<void> = () => {};
  /** Raised with the new asset key so the game can select it straight away. */
  onCharacterAdded: (key: string) => void | Promise<void> = () => {};

  constructor(private readonly library: AssetLibrary) {
    this.root = requireElement('#import-wizard');
    this.openButton = requireElement('#character-import-open');
    this.closeButton = requireElement('#import-wizard-close');
    this.bodyEl = requireElement('#import-wizard-body');
    this.statusEl = requireElement('#import-wizard-status');
    this.modelInput = requireElement<HTMLInputElement>('#import-model');
    this.clipsInput = requireElement<HTMLInputElement>('#import-clips');

    this.modelInput.accept = MODEL_ACCEPT;
    this.clipsInput.accept = MODEL_ACCEPT;

    this.openButton.addEventListener('click', this.onOpen);
    this.closeButton.addEventListener('click', this.onClose);
    this.modelInput.addEventListener('change', this.onModelPicked);
    this.clipsInput.addEventListener('change', this.onClipsPicked);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('is-hidden');
  }

  /** Drives the preview without rAF, for headless checks. */
  stepPreview(frames: number, delta: number): void {
    this.preview?.step(frames, delta);
  }

  dispose(): void {
    this.openButton.removeEventListener('click', this.onOpen);
    this.closeButton.removeEventListener('click', this.onClose);
    this.modelInput.removeEventListener('change', this.onModelPicked);
    this.clipsInput.removeEventListener('change', this.onClipsPicked);
    this.reset();
  }

  private readonly onOpen = () => {
    // Both panels dock to the same corner, and this one is launched from
    // inside the other — leaving it open just buries it.
    document.querySelector('#settings-panel')?.classList.add('is-hidden');
    this.root.classList.remove('is-hidden');
    this.render();
  };

  private readonly onClose = () => {
    this.root.classList.add('is-hidden');
    this.reset();
  };

  /** Frees every parsed scene, the harness and the preview's WebGL context. */
  private reset(): void {
    this.preview?.dispose();
    this.preview = null;
    this.harness?.dispose();
    this.harness = null;
    if (this.modelSource) {
      disposeObject3D(this.modelSource.scene);
      this.modelSource = null;
    }
    this.step = 'model';
    this.label = '';
    this.modelFile = null;
    this.target = null;
    this.rows = [];
    this.analysed = false;
    this.selectedRow = null;
    this.boneCount = 0;
    this.triangleCount = 0;
    this.modelInput.value = '';
    this.clipsInput.value = '';
    this.bodyEl.innerHTML = '';
    this.setStatus('', 'idle');
  }

  // ---------------------------------------------------------------- step 1

  private readonly onModelPicked = () => {
    const file = this.modelInput.files?.[0];
    this.modelInput.value = '';
    if (file) void this.loadModel(file);
  };

  private async loadModel(file: File): Promise<void> {
    const format = modelFormatOf(file.name);
    if (!format) {
      this.setStatus(`${file.name} is not a model file.`, 'error');
      return;
    }
    this.setStatus(`Reading ${file.name}…`, 'busy');
    try {
      if (this.modelSource) disposeObject3D(this.modelSource.scene);
      this.harness?.dispose();
      this.harness = null;
      this.rows = [];
      this.analysed = false;

      const source = await loadModelBytes(await file.arrayBuffer(), file.name);
      this.modelSource = source;
      this.modelFile = file;
      this.modelFormat = format;
      this.label = this.label || prettyLabel(file.name);

      // Built from the untouched scene: nothing ever plays a clip on it, so the
      // bind-pose bone translations that unit detection compares against stay
      // exactly as the file authored them.
      const rawHeight = Math.max(
        new THREE.Box3().setFromObject(source.scene).getSize(new THREE.Vector3()).y,
        0.01,
      );
      this.target = {
        boneNames: collectBoneNames(source.scene),
        bones: collectBones(source.scene),
        normalizationScale: TARGET_HEIGHT / rawHeight,
      };
      this.boneCount = this.target.boneNames.size;
      this.triangleCount = countTriangles(source.scene);

      // Clips baked into the model file are candidates like any other.
      if (source.animations.length > 0) this.addRows(file, source.animations);

      this.setStatus('', 'idle');
      this.render();
    } catch (error) {
      this.setStatus(errorMessage(error), 'error');
    }
  }

  // ---------------------------------------------------------------- step 2

  private readonly onClipsPicked = () => {
    const files = [...(this.clipsInput.files ?? [])];
    this.clipsInput.value = '';
    if (files.length > 0) void this.addClipFiles(files);
  };

  private async addClipFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (this.rows.some((row) => row.sourceFile === file)) continue;
      this.setStatus(`Parsing ${file.name}…`, 'busy');
      // FBX in particular parses synchronously and can run for a second on a
      // big rig; yielding keeps the panel responsive across a batch.
      await yieldToUi();
      try {
        const source = await loadModelBytes(await file.arrayBuffer(), file.name);
        if (source.animations.length === 0) {
          this.setStatus(`${file.name} contains no animation.`, 'error');
        } else {
          this.addRows(file, source.animations);
        }
        // Clips hold no GPU resources, so the geometry can go straight away.
        disposeObject3D(source.scene);
      } catch (error) {
        this.setStatus(`${file.name}: ${errorMessage(error)}`, 'error');
      }
      this.analysed = false;
      this.render();
    }
    if (this.statusEl.dataset.state === 'busy') this.setStatus('', 'idle');
  }

  private addRows(file: File, animations: THREE.AnimationClip[]): void {
    animations.forEach((clip, index) => {
      this.rows.push({
        id: `${file.name}#${index}`,
        sourceFile: file,
        fileName: file.name,
        clipIndex: index,
        clipName: clip.name || `${stripExtension(file.name)} ${index + 1}`,
        clipsInFile: animations.length,
        raw: clip,
        role: 'unused',
      });
    });
  }

  // ---------------------------------------------------------------- step 3

  /**
   * Retargets every clip onto this character's skeleton, measures it, and lets
   * the classifier propose roles. Runs once on entering the review step.
   */
  private async analyse(): Promise<void> {
    const target = this.target;
    const source = this.modelSource;
    if (!target || !source || this.analysed) return;

    this.harness?.dispose();
    this.harness = new ClipHarness(cloneSkinned(source.scene));

    for (const [index, row] of this.rows.entries()) {
      this.setStatus(`Analysing ${index + 1} of ${this.rows.length}…`, 'busy');
      await yieldToUi();
      row.prepared = prepareUploadedClip(row.raw, target);
      row.metrics = this.harness.measure(row.prepared.clip);
    }

    const candidates: ClipCandidate[] = this.rows.map((row) => ({
      fileId: row.fileName,
      fileName: row.fileName,
      clipIndex: row.clipIndex,
      clipName: row.clipName,
      metrics: row.metrics!,
      bindRate: row.prepared!.bindRate,
      clipsInFile: row.clipsInFile,
    }));
    classifyClips(candidates).forEach((result, index) => {
      this.rows[index].role = result.role;
    });

    this.analysed = true;
    this.setStatus('', 'idle');
  }

  private assignRole(rowId: string, role: RoleAssignment): void {
    const row = this.rows.find((candidate) => candidate.id === rowId);
    if (!row) return;
    const previous = row.role;
    if (role !== 'unused') {
      // Only one clip can hold a role. Handing the displaced clip this one's
      // old role keeps a straight swap from silently dropping a clip.
      const holder = this.rows.find((other) => other !== row && other.role === role);
      if (holder) holder.role = previous;
    }
    row.role = role;
    this.renderReviewState();
  }

  private async save(): Promise<void> {
    if (!this.modelFile || !this.target) return;
    const clips: CharacterImportClip[] = this.rows
      .filter((row) => row.role !== 'unused')
      .map((row) => ({
        sourceFile: row.sourceFile,
        clipIndex: row.clipIndex,
        clipName: row.clipName,
        role: row.role,
        duration: row.prepared?.clip.duration ?? row.raw.duration,
        measuredSpeed: row.prepared?.authoredSpeed ?? row.metrics?.groundSpeed ?? null,
        bindRate: row.prepared?.bindRate ?? null,
        unitScale: row.prepared?.unitScale ?? null,
        rootMotion: row.prepared?.hadRootMotion ?? null,
      }));

    this.setStatus('Saving…', 'busy');
    try {
      const asset = await this.library.addCharacterFromImport({
        label: this.label.trim() || prettyLabel(this.modelFile.name),
        model: this.modelFile,
        modelFormat: this.modelFormat,
        hasSkeleton: this.boneCount > 0,
        clips,
      });
      await this.onLibraryChanged();
      await this.onCharacterAdded(asset.key);
      this.onClose();
    } catch (error) {
      this.setStatus(errorMessage(error), 'error');
    }
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    // The review step owns a live WebGL canvas, so it is built once and then
    // patched in place rather than re-rendered from scratch.
    if (this.step === 'review') return;
    this.preview?.dispose();
    this.preview = null;
    this.bodyEl.innerHTML = '';
    if (this.step === 'model') this.renderModelStep();
    else this.renderClipsStep();
  }

  private renderModelStep(): void {
    this.bodyEl.append(
      stepHeading(1, 'Pick the character'),
      fileAction(
        'import-model',
        this.modelFile ? `Replace ${this.modelFile.name}` : 'Choose a model file',
        'GLB, GLTF, FBX, OBJ or STL. FBX and GLB can carry the rig; OBJ and STL never do.',
      ),
    );
    if (!this.modelFile) return;

    const nameField = document.createElement('label');
    nameField.className = 'wizard-field';
    nameField.textContent = 'Name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'import-label';
    nameInput.value = this.label;
    nameInput.addEventListener('input', () => {
      this.label = nameInput.value;
    });
    nameField.append(nameInput);

    this.bodyEl.append(
      nameField,
      factLine(
        `${this.modelFormat.toUpperCase()} · ${this.triangleCount.toLocaleString()} triangles · ` +
          `${this.boneCount} bones`,
      ),
    );

    if (this.boneCount === 0) {
      // A terminal state, not an error: the file is fine, it just has nothing
      // an animation clip could bind to.
      const notice = document.createElement('p');
      notice.className = 'wizard-notice';
      notice.id = 'import-no-skeleton';
      notice.textContent =
        'No skeleton — this mesh cannot be animated. Rig it in Mint and import the rigged ' +
        'version, or save it as-is to keep it in your library.';
      this.bodyEl.append(notice);
      this.bodyEl.append(
        actionRow(
          button('Queue a Mint rig', 'import-queue-rig', async () => {
            await this.library.addImport(
              'character',
              this.modelFile?.name ?? this.label,
              this.label,
            );
            this.setStatus(
              'Queued — open the Assets panel and copy the request to Claude.',
              'done',
            );
          }),
          button('Save as unplayable', 'import-save-unplayable', () => this.save(), 'primary'),
        ),
      );
      return;
    }

    this.bodyEl.append(
      actionRow(button('Next: add animation', 'import-next', () => {
        this.step = 'clips';
        this.render();
      }, 'primary')),
    );
  }

  private renderClipsStep(): void {
    this.bodyEl.append(
      stepHeading(2, 'Add its animation'),
      fileAction(
        'import-clips',
        'Choose animation files',
        'Select them all at once. A file holding several takes is fine — every clip inside it ' +
          'is read, not just the first.',
      ),
    );

    const list = document.createElement('ul');
    list.className = 'settings-list';
    list.id = 'import-clip-files';
    for (const [fileName, rows] of groupByFile(this.rows)) {
      const item = document.createElement('li');
      item.className = 'settings-row';
      const name = document.createElement('span');
      name.className = 'settings-row-name';
      name.textContent =
        rows.length === 1
          ? `${fileName} — 1 clip`
          : `${fileName} — ${rows.length} takes found`;
      item.append(name);
      item.append(
        rowButton('Remove', () => {
          this.rows = this.rows.filter((row) => row.fileName !== fileName);
          this.analysed = false;
          this.render();
        }),
      );
      list.append(item);
    }
    this.bodyEl.append(list);

    if (this.rows.length === 0) {
      this.bodyEl.append(
        factLine(
          'No clips yet. Skip this and the character borrows the built-in walk, run and jump.',
        ),
      );
    }

    this.bodyEl.append(
      actionRow(
        button('Back', 'import-back', () => {
          this.step = 'model';
          this.render();
        }),
        button(
          this.rows.length === 0 ? 'Skip and save' : 'Next: review',
          'import-next',
          async () => {
            if (this.rows.length === 0) {
              await this.save();
              return;
            }
            this.step = 'review';
            this.bodyEl.innerHTML = '';
            await this.analyse();
            this.renderReviewStep();
          },
          'primary',
        ),
      ),
    );
  }

  private renderReviewStep(): void {
    const source = this.modelSource;
    this.bodyEl.innerHTML = '';
    this.bodyEl.append(stepHeading(3, 'Check what each clip is'));

    const stage = document.createElement('div');
    stage.className = 'clip-preview';
    stage.id = 'clip-preview';
    this.bodyEl.append(stage);
    if (source) {
      this.preview = new ClipPreview();
      this.preview.mount(stage);
      this.preview.setModel(cloneSkinned(source.scene));
    }

    const table = document.createElement('ul');
    table.className = 'settings-list';
    table.id = 'import-clip-rows';
    this.bodyEl.append(table);

    for (const row of this.rows) {
      const item = document.createElement('li');
      item.className = 'clip-row';
      item.dataset.clipId = row.id;
      item.dataset.clipFile = row.fileName;
      item.title = `${row.fileName} · clip ${row.clipIndex + 1} of ${row.clipsInFile}`;

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'clip-row-main';
      play.addEventListener('click', () => {
        this.selectedRow = row.id;
        if (row.prepared) this.preview?.play(row.prepared.clip);
        this.renderReviewState();
      });

      const title = document.createElement('span');
      title.className = 'clip-row-name';
      // Exporter bookkeeping is stripped for display, but a clip with nothing
      // left is labelled so it is obvious the name told us nothing.
      const meaningful = meaningfulClipName(row.clipName);
      title.textContent = meaningful || `${row.clipName} (unnamed)`;

      const facts = document.createElement('span');
      facts.className = 'clip-row-facts';
      facts.textContent = describeRow(row);

      play.append(title, facts);
      item.append(play);

      const select = document.createElement('select');
      select.className = 'clip-role-select';
      select.dataset.clipId = row.id;
      for (const option of [...ROLES, 'unused'] as RoleAssignment[]) {
        const element = document.createElement('option');
        element.value = option;
        element.textContent = option;
        select.append(element);
      }
      select.value = row.role;
      select.addEventListener('change', () => {
        this.assignRole(row.id, select.value as RoleAssignment);
      });
      item.append(select);
      table.append(item);
    }

    const summary = document.createElement('p');
    summary.className = 'wizard-notice';
    summary.id = 'import-summary';
    this.bodyEl.append(summary);

    this.bodyEl.append(
      actionRow(
        button('Back', 'import-back', () => {
          this.step = 'clips';
          this.render();
        }),
        button('Save character', 'import-save', () => this.save(), 'primary'),
      ),
    );

    this.renderReviewState();
  }

  /** Patches the review step in place, so the preview canvas survives. */
  private renderReviewState(): void {
    for (const row of this.rows) {
      const item = this.bodyEl.querySelector<HTMLElement>(`.clip-row[data-clip-id="${cssEscape(row.id)}"]`);
      if (!item) continue;
      const weak = (row.prepared?.bindRate ?? 1) < MIN_CLIP_BINDING;
      item.classList.toggle('is-warning', weak);
      item.classList.toggle('is-selected', this.selectedRow === row.id);
      const facts = item.querySelector('.clip-row-facts');
      if (facts) facts.textContent = describeRow(row);
      const select = item.querySelector<HTMLSelectElement>('.clip-role-select');
      if (select && select.value !== row.role) select.value = row.role;
    }

    const assigned = ROLES.filter((role) => this.rows.some((row) => row.role === role));
    const borrowed = ROLES.filter((role) => !assigned.includes(role));
    const summary = this.bodyEl.querySelector('#import-summary');
    if (summary) {
      summary.textContent =
        (assigned.length > 0 ? `Own animation: ${assigned.join(', ')}. ` : '') +
        (borrowed.length > 0
          ? `${borrowed.join(', ')} will be borrowed from the built-in set.`
          : 'Every locomotion state is covered.');
    }
  }

  private setStatus(text: string, status: Status): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.state = status;
  }
}

function describeRow(row: ClipRow): string {
  const parts = [`${row.raw.duration.toFixed(2)}s`];
  const speed = row.prepared?.authoredSpeed ?? row.metrics?.groundSpeed ?? null;
  parts.push(speed === null ? 'speed unknown' : `${speed.toFixed(2)} m/s`);
  const bindRate = row.prepared?.bindRate;
  if (bindRate !== undefined) parts.push(`${Math.round(bindRate * 100)}% bound`);
  const unitScale = row.prepared?.unitScale ?? 1;
  if (unitScale !== 1) {
    parts.push(
      unitScale > 1
        ? `rescaled ÷${trimNumber(unitScale)}`
        : `rescaled ×${trimNumber(1 / unitScale)}`,
    );
  }
  if (row.prepared?.hadRootMotion) parts.push('root motion removed');
  if (row.clipsInFile > 1) parts.push(`take ${row.clipIndex + 1}/${row.clipsInFile}`);
  if (bindRate !== undefined && bindRate < MIN_CLIP_BINDING) {
    parts.push("— it's from a different rig");
  }
  return parts.join(' · ');
}

function trimNumber(value: number): string {
  return Number(value.toPrecision(4)).toString();
}

function groupByFile(rows: ClipRow[]): Map<string, ClipRow[]> {
  const groups = new Map<string, ClipRow[]>();
  for (const row of rows) {
    const group = groups.get(row.fileName);
    if (group) group.push(row);
    else groups.set(row.fileName, [row]);
  }
  return groups;
}

function countTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    total += Math.floor((index ? index.count : (position?.count ?? 0)) / 3);
  });
  return total;
}

function stepHeading(index: number, text: string): HTMLElement {
  const heading = document.createElement('p');
  heading.className = 'wizard-step';
  heading.textContent = `Step ${index} — ${text}`;
  return heading;
}

function fileAction(inputId: string, title: string, hint: string): HTMLElement {
  const label = document.createElement('label');
  label.className = 'settings-action';
  label.htmlFor = inputId;
  const titleEl = document.createElement('span');
  titleEl.className = 'settings-action-title';
  titleEl.textContent = title;
  const hintEl = document.createElement('span');
  hintEl.className = 'settings-action-hint';
  hintEl.textContent = hint;
  label.append(titleEl, hintEl);
  return label;
}

function factLine(text: string): HTMLElement {
  const line = document.createElement('p');
  line.className = 'wizard-fact';
  line.textContent = text;
  return line;
}

function actionRow(...buttons: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'wizard-actions';
  row.append(...buttons);
  return row;
}

function button(
  label: string,
  id: string,
  action: () => void | Promise<void>,
  kind: 'primary' | 'plain' = 'plain',
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = id;
  element.className = kind === 'primary' ? 'wizard-button is-primary' : 'wizard-button';
  element.textContent = label;
  element.addEventListener('click', () => {
    void Promise.resolve(action()).catch((error) => console.error(error));
  });
  return element;
}

function rowButton(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'settings-row-action';
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

/** Clip ids carry a filename, which can hold characters a selector would choke on. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function prettyLabel(name: string): string {
  return (
    stripExtension(name)
      .replace(/[-_]+/g, ' ')
      .replace(/\b(rigged|inplace|glb|fbx)\b/gi, '')
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
