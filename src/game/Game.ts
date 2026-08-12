import * as THREE from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';
import { InputController } from '../core/InputController';
import { Loop } from '../core/Loop';
import { PlayerController } from '../core/PlayerController';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { Character } from '../entities/Character';
import { ContactShadow } from '../entities/ContactShadow';
import { AssetLibrary } from '../mint/library';
import { loadCatalog, mergeLibraryAssets, type Catalog } from '../mint/registry';
import { EnvironmentLight } from '../systems/EnvironmentLight';
import { ThirdPersonCamera } from '../systems/ThirdPersonCamera';
import { Overlay } from '../ui/Overlay';
import { SettingsPanel } from '../ui/SettingsPanel';
import { CharacterImportWizard } from '../ui/CharacterImportWizard';
import { MintWorldManager } from '../world/MintWorld';
import { SplatGround } from '../world/SplatGround';

const MAX_DPR = 2;
const STORAGE_WORLD = 'mint-playground.world';
const STORAGE_CHARACTER = 'mint-playground.character';
const STORAGE_GROUND_OFFSET_PREFIX = 'mint-playground.groundOffset.';
const STORAGE_LIGHT_INTENSITY = 'mint-playground.lightIntensity';
const STORAGE_ARM_TUCK = 'mint-playground.armNarrowing';
const ARM_TUCK_STEP = 0.05;
const GROUND_OFFSET_STEP = 0.02;
const LIGHT_INTENSITY_STEP = 0.1;
// Collider surfaces sit slightly below the visible splat surface. These are
// only used when the splat-surface probe cannot resolve the gap; the value is
// tunable live with [ and ] and persisted per world.
const DEFAULT_GROUND_OFFSETS: Record<string, number> = {
  'world-neon-city': 0.18,
};
const FALLBACK_GROUND_OFFSET = 0.05;
// XZ offsets sampled around the spawn point when calibrating that gap.
const CALIBRATION_SAMPLES: Array<[number, number]> = [
  [0, 0],
  [1.2, 0.6],
  [-1.1, -0.7],
];
const CALIBRATION_DELAY_FRAMES = 90;
const CALIBRATION_RETRY_FRAMES = 45;
const CALIBRATION_ATTEMPTS = 14;
const CALIBRATION_ROUNDS = 8;
const SPLAT_GROUND_SEED_SAMPLES = 12;
const CALIBRATION_REACH = 2.5;
const MIN_CALIBRATED_OFFSET = -0.3;
const MAX_CALIBRATED_OFFSET = 1.2;
const CALIBRATION_AGREEMENT = 0.15;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  private readonly spark: SparkRenderer;
  private readonly input: InputController;
  private readonly overlay = new Overlay();
  private readonly worlds: MintWorldManager;
  private readonly controller = new PlayerController();
  private readonly cameraRig = new ThirdPersonCamera(this.camera);
  private readonly environment: EnvironmentLight;
  private readonly contactShadow = new ContactShadow();
  private readonly library = new AssetLibrary();
  private readonly settings = new SettingsPanel(this.library);
  private readonly importWizard = new CharacterImportWizard(this.library);
  private readonly splatGround: SplatGround;
  private catalog: Catalog = loadCatalog();
  private readonly loop = new Loop(
    (delta, elapsed) => this.update(delta, elapsed),
    () => this.render(),
  );

  private character: Character | null = null;
  private characterToken = 0;
  private worldLoading = false;
  private frame = 0;
  private elapsed = 0;
  private pausedForScreenshot = false;
  private reducedMotion = false;
  private groundOffsetSource: 'measured' | 'default' | 'manual' | 'stored' = 'stored';
  private armTuckTarget: number | null = null;
  private captureMode = false;
  private captureInputYaw: number | null = null;
  private pendingCalibration:
    | { worldKey: string; framesLeft: number; attemptsLeft: number; rounds: number[] }
    | null = null;
  private calibrationSamples: number[] = [];
  private calibrationNote = 'pending';
  private readonly moveInput = new THREE.Vector2();
  private readonly orbitInput = new THREE.Vector2();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    // enableLod drives RAD level-of-detail streaming; focalAdjustment sharpens
    // splat rendering at the cost of slight shimmer.
    this.spark = new SparkRenderer({
      renderer: this.renderer,
      enableLod: true,
      focalAdjustment: 2,
    });
    this.scene.add(this.spark);
    this.scene.background = new THREE.Color('#0b0b12');

    // Splats carry their own baked lighting; the character is lit from a probe
    // rendered out of that same splat world so the two match.
    this.environment = new EnvironmentLight(this.scene, this.spark, this.renderer);
    this.environment.setIntensity(this.loadLightIntensity());
    this.scene.add(this.contactShadow.mesh);

    this.worlds = new MintWorldManager(this.scene, this.library);
    this.splatGround = new SplatGround(this.worlds);
    this.controller.groundSampler = this.splatGround;
    this.input = new InputController(canvas);

    this.overlay.populate(this.catalog, this.initialWorldKey(), this.initialCharacterKey());
    this.overlay.onWorldChange = (key) => void this.switchWorld(key);
    this.overlay.onCharacterChange = (key) => void this.switchCharacter(key);
    this.settings.onLibraryChanged = () => this.reloadCatalog();
    this.importWizard.onLibraryChanged = () => this.reloadCatalog();
    this.importWizard.onCharacterAdded = (key) => this.switchCharacter(key);

    resizeRenderer(this.renderer, this.camera, MAX_DPR);
    this.cameraRig.snapTo(this.controller.position);
    this.installTestHooks();
    this.publishDiagnostics();

    void this.reloadCatalog().then(() => this.loadInitial());
  }

  /**
   * Rebuilds the switcher from the project registry plus anything uploaded into
   * this browser, keeping the current selections if they still exist.
   */
  private async reloadCatalog(): Promise<void> {
    try {
      const uploaded = await this.library.listAssets();
      this.catalog = mergeLibraryAssets(loadCatalog(), uploaded);
    } catch (error) {
      console.warn('Could not read the uploaded asset library:', error);
      this.catalog = loadCatalog();
    }
    this.overlay.populate(
      this.catalog,
      this.worlds.world?.entry.key ?? this.initialWorldKey(),
      this.character?.entry.key ?? this.initialCharacterKey(),
    );
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    this.overlay.dispose();
    this.settings.dispose();
    this.importWizard.dispose();
    this.characterToken += 1;
    if (this.character) {
      this.scene.remove(this.character.root);
      this.character.dispose();
      this.character = null;
    }
    this.scene.remove(this.contactShadow.mesh);
    this.contactShadow.dispose();
    this.environment.dispose();
    this.worlds.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private initialWorldKey(): string | null {
    const stored = localStorage.getItem(STORAGE_WORLD);
    if (stored && this.catalog.worlds.some((world) => world.key === stored)) return stored;
    return this.catalog.worlds[0]?.key ?? null;
  }

  private initialCharacterKey(): string | null {
    const stored = localStorage.getItem(STORAGE_CHARACTER);
    if (stored && this.catalog.characters.some((c) => c.key === stored)) return stored;
    return this.catalog.characters[0]?.key ?? null;
  }

  private async loadInitial(): Promise<void> {
    const worldKey = this.initialWorldKey();
    const characterKey = this.initialCharacterKey();
    if (!worldKey) {
      this.overlay.setStatus('No worlds registered in mint-assets.json yet.', 'error');
      return;
    }
    await Promise.all([
      this.switchWorld(worldKey),
      characterKey ? this.switchCharacter(characterKey) : Promise.resolve(),
    ]);
  }

  private async switchWorld(key: string): Promise<void> {
    const entry = this.catalog.worlds.find((world) => world.key === key);
    if (!entry) return;
    this.worldLoading = true;
    this.overlay.setStatus(`Loading ${entry.label}…`, 'loading');
    try {
      const loaded = await this.worlds.load(entry);
      if (!loaded) return; // superseded by a newer switch
      if (this.captureMode) loaded.root.visible = false;
      localStorage.setItem(STORAGE_WORLD, key);
      this.overlay.setSelected(key, null);
      this.splatGround.reset();
      if (this.worlds.usesSplatGround) {
        // Seed the height grid before spawning, so the character does not drop
        // through a world whose ground has not been sampled yet.
        for (let i = 0; i < SPLAT_GROUND_SEED_SAMPLES; i += 1) {
          this.splatGround.update(this.controller.position);
        }
      }
      this.controller.groundOffset = this.resolveGroundOffset(key);
      this.controller.spawn(this.worlds.colliderMeshes);
      this.contactShadow.snapTo(this.controller.position);
      this.cameraRig.snapTo(this.controller.position);
      this.environment.invalidate();
      this.environment.requestBake(this.controller.position, this.hiddenDuringBake(), true);
      this.overlay.setStatus(`${entry.label} ready`, 'ready');
      this.worldLoading = false;
    } catch (error) {
      console.error('World load failed:', error);
      this.overlay.setStatus(
        `Could not load ${entry.label}. Pick it again to retry.`,
        'error',
      );
      this.worldLoading = false;
    }
  }

  private async switchCharacter(key: string): Promise<void> {
    const entry = this.catalog.characters.find((c) => c.key === key);
    if (!entry) return;
    const token = ++this.characterToken;
    this.overlay.setStatus(`Loading ${entry.label}…`, 'loading');
    try {
      const next = await Character.load(entry, this.library);
      if (token !== this.characterToken) {
        next.dispose();
        return;
      }
      if (this.character) {
        this.scene.remove(this.character.root);
        this.character.dispose();
      }
      this.character = next;
      this.character.setReducedMotion(this.reducedMotion);
      if (this.armTuckTarget === null) this.armTuckTarget = this.loadArmTuck();
      if (this.armTuckTarget !== null) next.setArmNarrowing(this.armTuckTarget);
      next.root.position.copy(this.controller.position);
      next.root.rotation.y = this.controller.yaw;
      this.scene.add(next.root);
      this.environment.requestBake(this.controller.position, this.hiddenDuringBake(), true);
      localStorage.setItem(STORAGE_CHARACTER, key);
      this.overlay.setSelected(null, key);
      if (!this.worldLoading) {
        // A character that cannot be animated used to report "ready" exactly
        // like a working one, which made a dead upload look like a live one.
        const source = next.animationSource;
        const note =
          source === 'none'
            ? next.hasSkeleton
              ? ' — no animation available'
              : ' — no skeleton, cannot be animated'
            : source === 'own'
              ? ' ready'
              : ' ready · borrowed animation';
        this.overlay.setStatus(
          `${entry.label}${note}`,
          source === 'none' ? 'error' : 'ready',
        );
      }
    } catch (error) {
      console.error('Character load failed:', error);
      if (token === this.characterToken) {
        this.overlay.setStatus(`Could not load ${entry.label}. Pick it again to retry.`, 'error');
      }
    }
  }

  private update(delta: number, _elapsed: number): void {
    this.frame += 1;
    if (this.input.consumeHideUiToggle()) {
      this.overlay.toggleHidden();
      this.settings.setHidden(this.overlay.hidden);
    }
    this.applyGroundOffsetSteps();
    this.applyLightSteps();
    this.applyArmTuckSteps();
    this.applyAutoOrbitInput();
    if (this.input.consumeRebakeRequest()) {
      this.environment.requestBake(this.controller.position, this.hiddenDuringBake(), true);
      this.overlay.setStatus('Re-baking world light…', 'loading');
    }

    if (this.pausedForScreenshot) {
      this.publishDiagnostics();
      return;
    }
    this.elapsed += delta;

    resizeRenderer(this.renderer, this.camera, MAX_DPR);
    this.tickCalibration();
    this.splatGround.update(this.controller.position);

    this.input.readMovement(this.moveInput);
    const jumpRequested = this.input.consumeJump();
    this.controller.update(
      delta,
      this.moveInput,
      this.input.isRunHeld(),
      jumpRequested,
      this.captureInputYaw ?? this.cameraRig.movementYaw,
      this.worlds.colliderMeshes,
    );

    if (this.character) {
      this.character.root.position.copy(this.controller.position);
      this.character.root.rotation.y = this.controller.yaw;
      if (this.controller.justJumped) this.character.triggerJump();
      this.character.update(delta, this.controller.horizontalSpeed, this.controller.grounded);
    }

    this.contactShadow.update(
      delta,
      this.controller.groundPoint,
      this.controller.groundNormal,
      this.controller.heightAboveGround,
      this.environment.keyDirection,
    );
    if (this.worlds.world && !this.captureMode) {
      this.environment.requestBake(this.controller.position, this.hiddenDuringBake());
    }

    this.input.consumeOrbit(this.orbitInput);
    this.cameraRig.update(delta, this.controller.position, this.orbitInput, this.input.consumeZoom());
    this.publishDiagnostics();
  }

  /**
   * A world's collider sits below the surface you can actually see, which is
   * what made the character look sunk into the road. Measure that gap directly
   * by comparing the collider with the splat surface, and only fall back to a
   * hand-tuned number when the measurement is unusable.
   */
  private resolveGroundOffset(worldKey: string): number {
    const stored = localStorage.getItem(`${STORAGE_GROUND_OFFSET_PREFIX}${worldKey}`);
    if (stored !== null) {
      const value = Number.parseFloat(stored);
      if (Number.isFinite(value)) {
        this.groundOffsetSource = 'stored';
        return value;
      }
    }
    // Splat pages stream in during rendering, so the surface probe has nothing
    // to hit for the first second or two. Retry until the data is resident.
    this.pendingCalibration = {
      worldKey,
      framesLeft: CALIBRATION_DELAY_FRAMES,
      attemptsLeft: CALIBRATION_ATTEMPTS,
      rounds: [],
    };
    this.groundOffsetSource = 'default';
    return DEFAULT_GROUND_OFFSETS[worldKey] ?? FALLBACK_GROUND_OFFSET;
  }

  private tickCalibration(): void {
    const pending = this.pendingCalibration;
    if (!pending) return;
    if (pending.worldKey !== this.worlds.world?.entry.key) {
      this.pendingCalibration = null;
      return;
    }
    pending.framesLeft -= 1;
    if (pending.framesLeft > 0) return;
    pending.framesLeft = CALIBRATION_RETRY_FRAMES;
    pending.attemptsLeft -= 1;

    const measured = this.calibrateGroundOffset();
    if (measured !== null) {
      // Low-detail splats are drawn inflated, so an early reading sits too high
      // and settles downward as pages stream in. Keep the smallest converged
      // reading rather than the first one.
      pending.rounds.push(measured);
      const best = Math.min(...pending.rounds);
      this.controller.groundOffset = best;
      this.groundOffsetSource = 'measured';
      localStorage.setItem(`${STORAGE_GROUND_OFFSET_PREFIX}${pending.worldKey}`, best.toFixed(3));
    }

    if (pending.attemptsLeft <= 0 || pending.rounds.length >= CALIBRATION_ROUNDS) {
      this.pendingCalibration = null;
    }
  }

  private calibrateGroundOffset(): number | null {
    const colliders = this.worlds.colliderMeshes;
    if (colliders.length === 0) {
      this.calibrationNote = 'no collider meshes';
      return null;
    }

    const deltas: number[] = [];
    const notes: string[] = [];
    for (const [x, z] of CALIBRATION_SAMPLES) {
      const colliderY = this.controller.sampleColliderHeight(x, z, colliders);
      if (colliderY === null) {
        notes.push('collider miss');
        continue;
      }
      const splatY = this.worlds.sampleSplatHeight(x, z, colliderY, CALIBRATION_REACH);
      if (splatY === null) {
        notes.push(`splat miss @${colliderY.toFixed(2)}`);
        continue;
      }
      const delta = splatY - colliderY;
      if (Number.isFinite(delta)) deltas.push(delta);
    }
    this.calibrationSamples = deltas.map((value) => Number(value.toFixed(3)));
    this.calibrationNote = notes.length > 0 ? notes.join(', ') : 'ok';

    const usable = deltas.filter(
      (value) => value >= MIN_CALIBRATED_OFFSET && value <= MAX_CALIBRATED_OFFSET,
    );
    if (usable.length < 2) return null;

    usable.sort((a, b) => a - b);
    const median = usable[Math.floor(usable.length / 2)];
    // Two independent samples have to agree, or we are reading noise off a
    // sparse patch of splats rather than the floor.
    const agreeing = usable.filter((value) => Math.abs(value - median) <= CALIBRATION_AGREEMENT);
    return agreeing.length >= 2 ? median : null;
  }

  private applyGroundOffsetSteps(): void {
    const steps = this.input.consumeGroundOffsetSteps();
    if (steps === 0) return;
    const worldKey = this.worlds.world?.entry.key;
    if (!worldKey) return;
    const offset = this.controller.groundOffset + steps * GROUND_OFFSET_STEP;
    this.controller.groundOffset = offset;
    this.groundOffsetSource = 'manual';
    localStorage.setItem(`${STORAGE_GROUND_OFFSET_PREFIX}${worldKey}`, offset.toFixed(3));
    this.overlay.setStatus(`Ground height: ${offset.toFixed(2)}`, 'ready');
  }

  private loadLightIntensity(): number {
    const stored = localStorage.getItem(STORAGE_LIGHT_INTENSITY);
    if (stored === null) return 1;
    const value = Number.parseFloat(stored);
    return Number.isFinite(value) ? value : 1;
  }

  private loadArmTuck(): number | null {
    const stored = localStorage.getItem(STORAGE_ARM_TUCK);
    if (stored === null) return null;
    const value = Number.parseFloat(stored);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * O toggles the orbit, Q/E steer it. Reported through the status line because
   * a camera that starts moving on its own should say why.
   */
  private applyAutoOrbitInput(): void {
    const toggles = this.input.consumeAutoOrbitToggles();
    const steps = this.input.consumeAutoOrbitSteps();
    if (toggles === 0 && steps === 0) return;

    // Odd numbers of presses flip; even ones cancel out.
    if (toggles % 2 === 1) this.cameraRig.toggleAutoOrbit();
    if (steps !== 0) this.cameraRig.steerAutoOrbit(steps < 0 ? -1 : 1);

    const speed = this.cameraRig.autoOrbitSpeed;
    if (speed === 0) {
      this.overlay.setStatus('Camera orbit off', 'ready');
      return;
    }
    const seconds = (2 * Math.PI) / Math.abs(speed);
    this.overlay.setStatus(
      `Camera orbit ${speed < 0 ? 'left' : 'right'} · ${seconds.toFixed(0)}s per lap`,
      'ready',
    );
  }

  private applyArmTuckSteps(): void {
    const steps = this.input.consumeArmTuckSteps();
    if (steps === 0 || !this.character) return;
    const value = this.character.setArmNarrowing(this.character.armTuck + steps * ARM_TUCK_STEP);
    this.armTuckTarget = value;
    localStorage.setItem(STORAGE_ARM_TUCK, value.toFixed(2));
    this.overlay.setStatus(`Arm narrowing: ${Math.round(value * 100)}%`, 'ready');
  }

  private applyLightSteps(): void {
    const steps = this.input.consumeLightSteps();
    if (steps === 0) return;
    const intensity = this.environment.setIntensity(
      this.environment.lightIntensity + steps * LIGHT_INTENSITY_STEP,
    );
    localStorage.setItem(STORAGE_LIGHT_INTENSITY, intensity.toFixed(2));
    this.overlay.setStatus(`Character light: ${intensity.toFixed(2)}`, 'ready');
  }

  /** Objects that must not appear in the character's own light probe. */
  private hiddenDuringBake(): THREE.Object3D[] {
    const hidden: THREE.Object3D[] = [this.contactShadow.mesh];
    if (this.character) hidden.push(this.character.root);
    return hidden;
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: () => {},
      setState: (name: string) => {
        if (name === 'active-play') this.controller.resetToSpawn();
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
        this.character?.setReducedMotion(enabled);
      },
      hideDebugUi: (hidden: boolean) => {
        this.overlay.setHidden(hidden);
      },
      // Drives the simulation without requestAnimationFrame, so headless
      // checks can advance and measure the game deterministically.
      step: (frames = 1, delta = 1 / 60) => {
        for (let i = 0; i < frames; i += 1) this.update(delta, this.elapsed);
      },
      describeRig: () => this.character?.describeRig() ?? null,
      describeClips: () => this.character?.describeClips() ?? null,
      hipOffset: () => this.character?.hipOffset() ?? null,
      stepPreview: (frames = 1, delta = 1 / 30) => {
        this.importWizard?.stepPreview(frames, delta);
      },
      // Hides the splat world and suspends light baking. Headless GPUs render
      // millions of splats in software, which starves the compositor and makes
      // screenshots time out; a plain background also shows a gait far better.
      setCaptureMode: (enabled: boolean) => {
        this.captureMode = enabled;
        const world = this.worlds.world;
        if (world) world.root.visible = !enabled;
        this.scene.background = new THREE.Color(enabled ? '#8d93a1' : '#0b0b12');
      },
      // Fixes the camera so a gait can be captured from a repeatable angle.
      setAutoOrbit: (enabled: boolean, direction?: number) => {
        if (direction !== undefined && direction !== 0) {
          this.cameraRig.steerAutoOrbit(direction < 0 ? -1 : 1);
        }
        this.cameraRig.setAutoOrbit(enabled);
      },
      cameraState: () => ({
        yaw: this.cameraRig.yaw,
        movementYaw: this.cameraRig.movementYaw,
        autoOrbit: this.cameraRig.autoOrbitEnabled,
        autoOrbitSpeed: this.cameraRig.autoOrbitSpeed,
      }),
      setCameraPose: (yaw: number, pitch: number, distance: number) => {
        this.cameraRig.yaw = yaw;
        this.cameraRig.pitch = pitch;
        this.cameraRig.distance = distance;
        this.cameraRig.snapTo(this.controller.position);
      },
      // Movement is normally camera-relative, so the camera only ever sees the
      // character's back. Pinning the input direction lets the camera sit
      // side-on while the character keeps walking the same way.
      setInputYaw: (yaw: number | null) => {
        this.captureInputYaw = yaw;
      },
      probeGround: (x: number, z: number, fromY: number, reach: number) => ({
        collider: this.controller.sampleColliderHeight(x, z, this.worlds.colliderMeshes),
        splat: this.worlds.sampleSplatHeight(x, z, fromY, reach),
      }),
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      score: 0,
      targetScore: 0,
      complete: false,
      player: {
        position: {
          x: this.controller.position.x,
          y: this.controller.position.y,
          z: this.controller.position.z,
        },
        speed: this.controller.horizontalSpeed,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
      },
      world: this.worlds.world?.entry.key ?? null,
      character: this.character?.entry.key ?? null,
      environment: this.environment.diagnostics(),
      grounding: {
        offset: this.controller.groundOffset,
        offsetSource: this.groundOffsetSource,
        grounded: this.controller.grounded,
        heightAboveGround: this.controller.heightAboveGround,
        footCorrection: this.character?.footCorrection ?? 0,
        calibrationSamples: this.calibrationSamples,
        calibrationNote: this.calibrationNote,
        armTuckTarget: this.character?.armTuck ?? 0,
        clipSpeeds: this.character?.clipSpeeds ?? { walk: 0, run: 0, feet: 0 },
        armSpread: this.character?.armSpread ?? {
          leftBefore: 0,
          rightBefore: 0,
          leftAfter: 0,
          rightAfter: 0,
          bones: 0,
        },
        shadowVisible: this.contactShadow.mesh.visible,
        shadowOpacity: (this.contactShadow.mesh.material as THREE.Material).opacity,
      },
    };
  }
}
