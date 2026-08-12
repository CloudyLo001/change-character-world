import * as THREE from 'three';
import { disposeObject3D } from '../utils/dispose';

/**
 * A small self-contained viewport for auditioning a clip on the character it is
 * about to be assigned to. Deliberately does not share anything with the game's
 * renderer: a second context costs less than entangling the import UI with the
 * splat pipeline's environment baking and camera state.
 */

const PREVIEW_FPS = 30;
const MAX_DELTA = 0.1;
const TARGET_HEIGHT = 1.75;

export class ClipPreview {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60);
  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private observer: ResizeObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;
  /** Set while a test drives frames by hand, so the interval stays out of it. */
  private manual = false;

  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private action: THREE.AnimationAction | null = null;

  mount(container: HTMLElement): void {
    if (this.renderer) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'clip-preview-canvas';
    container.append(canvas);
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x30323c, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(2.4, 3.6, 3.2);
    this.scene.add(key);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x5a6078, transparent: true, opacity: 0.25 }),
    );
    this.scene.add(ground);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();

    document.addEventListener('visibilitychange', this.onVisibility);
    this.start();
  }

  /** Takes ownership of `model`; it is disposed with the preview. */
  setModel(model: THREE.Object3D): void {
    this.clearModel();
    // Match the gameplay normalization so the framing is the same whatever the
    // source file's units were.
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    model.scale.multiplyScalar(TARGET_HEIGHT / Math.max(size.y, 0.01));
    bounds.setFromObject(model);
    model.position.y -= bounds.min.y;
    model.position.x -= (bounds.min.x + bounds.max.x) / 2;
    model.position.z -= (bounds.min.z + bounds.max.z) / 2;

    this.model = model;
    this.scene.add(model);
    this.mixer = new THREE.AnimationMixer(model);

    this.camera.position.set(1.5, 1.35, 2.5);
    this.camera.lookAt(0, TARGET_HEIGHT * 0.52, 0);
    this.render();
  }

  play(clip: THREE.AnimationClip): void {
    if (!this.mixer) return;
    this.stop();
    this.action = this.mixer.clipAction(clip);
    this.action.reset();
    this.action.setEffectiveWeight(1);
    this.action.play();
    this.lastFrame = performance.now();
  }

  stop(): void {
    if (this.action) {
      this.action.stop();
      this.mixer?.uncacheAction(this.action.getClip());
      this.action = null;
    }
    // Back to the bind pose, so a cleared selection does not leave the last
    // frame of the previous clip frozen on screen.
    this.mixer?.setTime(0);
    this.render();
  }

  /**
   * Advances and redraws by hand. `ClipPreview` never uses requestAnimationFrame
   * — it does not fire at all when the page reports itself hidden, which is the
   * normal state in an embedded preview pane, and a clip audition has no need
   * for vsync accuracy anyway.
   */
  tick(delta: number): void {
    this.mixer?.update(Math.min(Math.max(delta, 0), MAX_DELTA));
    this.render();
  }

  /** Suspends the interval so a test can step frames deterministically. */
  setManual(manual: boolean): void {
    this.manual = manual;
    if (manual) this.stopTimer();
    else this.start();
  }

  step(frames = 1, delta = 1 / PREVIEW_FPS): void {
    this.setManual(true);
    for (let i = 0; i < frames; i += 1) this.tick(delta);
  }

  dispose(): void {
    this.stopTimer();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.observer?.disconnect();
    this.observer = null;
    this.clearModel();
    disposeObject3D(this.scene);
    this.scene.clear();
    if (this.renderer) {
      this.renderer.dispose();
      // Browsers cap live WebGL contexts at around 16. Without this an import
      // wizard opened and closed a dozen times would take the game's own
      // context down with it.
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
    this.canvas?.remove();
    this.canvas = null;
  }

  private clearModel(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
      this.mixer = null;
    }
    this.action = null;
    if (this.model) {
      this.scene.remove(this.model);
      disposeObject3D(this.model);
      this.model = null;
    }
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') this.stopTimer();
    else this.start();
  };

  private start(): void {
    if (this.timer !== null || this.manual || !this.renderer) return;
    this.lastFrame = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const delta = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      this.tick(delta);
    }, 1000 / PREVIEW_FPS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private resize(): void {
    const parent = this.canvas?.parentElement;
    if (!this.renderer || !parent) return;
    const width = Math.max(parent.clientWidth, 1);
    const height = Math.max(parent.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private render(): void {
    this.renderer?.render(this.scene, this.camera);
  }
}
