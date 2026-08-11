import type { Catalog } from '../mint/registry';

export type StatusKind = 'loading' | 'ready' | 'error';

/**
 * Compact bottom-centered overlay: a status line above two selectors (world,
 * character) and the control hint. Toggled entirely with the H key.
 */
export class Overlay {
  private readonly rootEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly worldSelect: HTMLSelectElement;
  private readonly characterSelect: HTMLSelectElement;
  private isHidden = false;

  onWorldChange: (key: string) => void = () => {};
  onCharacterChange: (key: string) => void = () => {};

  private readonly onWorldInput = () => {
    this.worldSelect.blur();
    this.onWorldChange(this.worldSelect.value);
  };

  private readonly onCharacterInput = () => {
    this.characterSelect.blur();
    this.onCharacterChange(this.characterSelect.value);
  };

  constructor() {
    this.rootEl = requireElement('#overlay');
    this.statusEl = requireElement('#status-line');
    this.worldSelect = requireElement<HTMLSelectElement>('#world-select');
    this.characterSelect = requireElement<HTMLSelectElement>('#character-select');
    this.worldSelect.addEventListener('change', this.onWorldInput);
    this.characterSelect.addEventListener('change', this.onCharacterInput);
  }

  populate(catalog: Catalog, worldKey: string | null, characterKey: string | null): void {
    fillSelect(this.worldSelect, catalog.worlds, worldKey);
    fillSelect(this.characterSelect, catalog.characters, characterKey);
    this.characterSelect.disabled = catalog.characters.length === 0;
    if (catalog.characters.length === 0) {
      this.characterSelect.innerHTML = '<option>No characters synced yet</option>';
    }
  }

  setSelected(worldKey: string | null, characterKey: string | null): void {
    if (worldKey) this.worldSelect.value = worldKey;
    if (characterKey) this.characterSelect.value = characterKey;
  }

  setStatus(text: string, kind: StatusKind): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = kind;
    this.statusEl.classList.toggle('is-hidden', kind === 'ready' && text === '');
  }

  get hidden(): boolean {
    return this.isHidden;
  }

  toggleHidden(): void {
    this.setHidden(!this.isHidden);
  }

  setHidden(hidden: boolean): void {
    this.isHidden = hidden;
    this.rootEl.classList.toggle('is-hidden', hidden);
  }

  dispose(): void {
    this.worldSelect.removeEventListener('change', this.onWorldInput);
    this.characterSelect.removeEventListener('change', this.onCharacterInput);
  }
}

function fillSelect(
  select: HTMLSelectElement,
  entries: Array<{ key: string; label: string }>,
  selectedKey: string | null,
): void {
  select.innerHTML = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.key;
    option.textContent = entry.label;
    select.append(option);
  }
  if (selectedKey && entries.some((entry) => entry.key === selectedKey)) {
    select.value = selectedKey;
  }
}

function requireElement<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
