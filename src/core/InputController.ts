import * as THREE from 'three';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Keyboard + pointer input: WASD/arrows movement, Shift run, Space jump
 * (edge-triggered), pointer-drag orbit, and wheel zoom.
 */
export class InputController {
  private readonly keys = new Set<string>();
  private readonly moveVector = new THREE.Vector2();
  private readonly orbitDelta = new THREE.Vector2();
  private jumpQueued = false;
  private zoomDelta = 0;
  private dragPointerId: number | null = null;
  private lastDragX = 0;
  private lastDragY = 0;
  private hideUiRequested = false;
  private groundOffsetSteps = 0;
  private lightSteps = 0;
  private armTuckSteps = 0;
  private rebakeRequested = false;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) return;
    if (event.code === 'Space' && !event.repeat) this.jumpQueued = true;
    if (event.code === 'KeyH' && !event.repeat) this.hideUiRequested = true;
    if (event.code === 'KeyL' && !event.repeat) this.rebakeRequested = true;
    if (event.code === 'BracketLeft') this.groundOffsetSteps -= 1;
    if (event.code === 'BracketRight') this.groundOffsetSteps += 1;
    if (event.code === 'Comma') this.lightSteps -= 1;
    if (event.code === 'Period') this.lightSteps += 1;
    if (event.code === 'Semicolon') this.armTuckSteps -= 1;
    if (event.code === 'Quote') this.armTuckSteps += 1;
    if (event.code === 'Space') event.preventDefault();
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = () => {
    this.keys.clear();
    this.dragPointerId = null;
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.dragPointerId = event.pointerId;
    this.lastDragX = event.clientX;
    this.lastDragY = event.clientY;
    try {
      this.surface.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events cannot always be captured.
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.dragPointerId) return;
    this.orbitDelta.x += event.clientX - this.lastDragX;
    this.orbitDelta.y += event.clientY - this.lastDragY;
    this.lastDragX = event.clientX;
    this.lastDragY = event.clientY;
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerId === this.dragPointerId) this.dragPointerId = null;
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.zoomDelta += event.deltaY;
  };

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('pointermove', this.onPointerMove);
    surface.addEventListener('pointerup', this.onPointerUp);
    surface.addEventListener('pointercancel', this.onPointerUp);
    surface.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** x = strafe (+right), y = forward (+forward). */
  readMovement(target: THREE.Vector2): THREE.Vector2 {
    this.moveVector.set(0, 0);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.moveVector.x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.moveVector.x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.moveVector.y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.moveVector.y -= 1;
    if (this.moveVector.lengthSq() > 1) this.moveVector.normalize();
    return target.copy(this.moveVector);
  }

  isRunHeld(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  consumeJump(): boolean {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  /** Net [-]/[+] ground-offset key presses since the last call. */
  consumeGroundOffsetSteps(): number {
    const steps = this.groundOffsetSteps;
    this.groundOffsetSteps = 0;
    return steps;
  }

  /** Net , / . character-light key presses since the last call. */
  consumeLightSteps(): number {
    const steps = this.lightSteps;
    this.lightSteps = 0;
    return steps;
  }

  /** Net ; / ' arm-tuck key presses since the last call. */
  consumeArmTuckSteps(): number {
    const steps = this.armTuckSteps;
    this.armTuckSteps = 0;
    return steps;
  }

  consumeRebakeRequest(): boolean {
    const requested = this.rebakeRequested;
    this.rebakeRequested = false;
    return requested;
  }

  consumeHideUiToggle(): boolean {
    const requested = this.hideUiRequested;
    this.hideUiRequested = false;
    return requested;
  }

  consumeOrbit(target: THREE.Vector2): THREE.Vector2 {
    target.copy(this.orbitDelta);
    this.orbitDelta.set(0, 0);
    return target;
  }

  consumeZoom(): number {
    const delta = this.zoomDelta;
    this.zoomDelta = 0;
    return delta;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.surface.removeEventListener('pointermove', this.onPointerMove);
    this.surface.removeEventListener('pointerup', this.onPointerUp);
    this.surface.removeEventListener('pointercancel', this.onPointerUp);
    this.surface.removeEventListener('wheel', this.onWheel);
  }
}
