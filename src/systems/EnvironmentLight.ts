import * as THREE from 'three';
import type { SparkRenderer } from '@sparkjsdev/spark';

const CUBE_SIZE = 128;
const BAKE_MOVE_DISTANCE = 6;
const BAKE_MIN_INTERVAL_MS = 1500;
const PROBE_EYE_HEIGHT = 1.4;
const PIXEL_STRIDE = 2;

/** Cube render target layer order: +X, -X, +Y, -Y, +Z, -Z. */
const FACE_DIRECTIONS: readonly THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];
const SKY_FACE = 2;
const GROUND_FACE = 3;

// Pre-bake fallbacks: a neutral studio rig so a character is never unlit while
// the first probe is still rendering.
const FALLBACK_SKY = new THREE.Color('#dfe8ff');
const FALLBACK_GROUND = new THREE.Color('#3a3348');
const FALLBACK_KEY = new THREE.Color('#fff2df');

// Once real image-based lighting is in place the analytic lights only shape
// the form; the environment map supplies ambient.
const BAKED_HEMISPHERE_INTENSITY = 0.35;
const MIN_KEY_INTENSITY = 0.35;
const MAX_KEY_INTENSITY = 2.2;
// A night street is genuinely dark, but a character lit purely by it goes to
// mud on video. Lift dark worlds without touching bright ones.
const LIFT_BELOW_LUMINANCE = 0.35;
const MAX_LIFT = 1.8;
// A capture this dark means the world had not streamed in yet, not that the
// world is black. Applying it would blacken the character, so retry instead.
const MIN_VALID_LUMINANCE = 0.02;

interface FaceSample {
  color: THREE.Color;
  luminance: number;
}

export interface EnvironmentDiagnostics {
  baked: boolean;
  baking: boolean;
  bakeCount: number;
  rejectedBakes: number;
  lastBakeMs: number;
  intensity: number;
  keyColor: string;
  keyIntensity: number;
  keyDirection: { x: number; y: number; z: number };
  skyColor: string;
  groundColor: string;
  meanLuminance: number;
  exposureLift: number;
}

/**
 * Lights the character from the world it is standing in. Spark can render the
 * loaded splat scene into a cube map, so the actual neon signs / sky / grass
 * around the character become both an image-based lighting probe and a derived
 * key light, instead of a fixed studio rig that ignores the world.
 */
export class EnvironmentLight {
  readonly hemisphere = new THREE.HemisphereLight(FALLBACK_SKY, FALLBACK_GROUND, 1.4);
  readonly key = new THREE.DirectionalLight(FALLBACK_KEY, 1.6);
  /** Unit vector pointing from the scene toward the dominant light. */
  readonly keyDirection = new THREE.Vector3(0.4, 1, 0.3).normalize();

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly bakeCenter = new THREE.Vector3();
  private readonly probeCenter = new THREE.Vector3();
  private envMap: THREE.Texture | null = null;
  private baking = false;
  private baked = false;
  private bakeCount = 0;
  private lastBakeMs = 0;
  private lastBakeAt = Number.NEGATIVE_INFINITY;
  private rejectedBakes = 0;
  private intensity = 1;
  private keyIntensity = 1.6;
  private meanLuminance = 0;
  private exposureLift = 1;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly spark: SparkRenderer,
    renderer: THREE.WebGLRenderer,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.key.position.copy(this.keyDirection).multiplyScalar(10);
    scene.add(this.hemisphere);
    scene.add(this.key);
  }

  get isBaking(): boolean {
    return this.baking;
  }

  setIntensity(value: number): number {
    this.intensity = THREE.MathUtils.clamp(value, 0.1, 3);
    this.applyIntensity();
    return this.intensity;
  }

  get lightIntensity(): number {
    return this.intensity;
  }

  /** Drops the probe so the next update re-bakes against a newly loaded world. */
  invalidate(): void {
    this.baked = false;
    this.lastBakeAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Re-bakes when the character has walked far enough for the surrounding
   * light to have genuinely changed, rate-limited so it never runs back to back.
   */
  requestBake(position: THREE.Vector3, hideObjects: THREE.Object3D[], force = false): void {
    if (this.baking) return;
    const now = performance.now();
    if (!force) {
      if (now - this.lastBakeAt < BAKE_MIN_INTERVAL_MS) return;
      if (this.baked && this.bakeCenter.distanceTo(position) < BAKE_MOVE_DISTANCE) return;
    }
    this.probeCenter.copy(position).setY(position.y + PROBE_EYE_HEIGHT);
    void this.bake(this.probeCenter.clone(), hideObjects);
  }

  private async bake(center: THREE.Vector3, hideObjects: THREE.Object3D[]): Promise<void> {
    this.baking = true;
    const started = performance.now();
    // LOD foveation inflates splats outside the forward cone, and the cube
    // capture faces six directions at once. Flatten it for the bake only.
    const saved = {
      autoUpdate: this.spark.autoUpdate,
      coneFov0: this.spark.coneFov0,
      coneFov: this.spark.coneFov,
      coneFoveate: this.spark.coneFoveate,
      behindFoveate: this.spark.behindFoveate,
    };
    try {
      this.spark.autoUpdate = false;
      this.spark.coneFov0 = 0;
      this.spark.coneFov = 0;
      this.spark.coneFoveate = 1;
      this.spark.behindFoveate = 1;

      const cube = await this.spark.renderCubeMap({
        scene: this.scene,
        worldCenter: center,
        size: CUBE_SIZE,
        hideObjects,
        update: true,
        filter: true,
      });
      const faces = await this.spark.readCubeTargets();
      const samples = faces.map((pixels) => sampleFace(pixels));
      const luminance =
        samples.reduce((sum, sample) => sum + sample.luminance, 0) / Math.max(1, samples.length);

      // Leave `baked` false on a dud so the throttle retries it, rather than
      // locking in black lighting for a world that is still loading.
      this.rejectedBakes += luminance < MIN_VALID_LUMINANCE ? 1 : 0;
      if (luminance < MIN_VALID_LUMINANCE) return;

      const previous = this.envMap;
      this.envMap = this.pmrem.fromCubemap(cube).texture;
      previous?.dispose();
      this.scene.environment = this.envMap;

      this.applyFaceSamples(samples);
      this.bakeCenter.copy(center);
      this.baked = true;
      this.bakeCount += 1;
      this.lastBakeMs = performance.now() - started;
    } catch (error) {
      console.warn('Environment probe bake failed; keeping previous lighting.', error);
    } finally {
      Object.assign(this.spark, saved);
      this.lastBakeAt = performance.now();
      this.baking = false;
    }
  }

  private applyFaceSamples(samples: FaceSample[]): void {
    if (samples.length < FACE_DIRECTIONS.length) return;

    const luminances = samples.map((sample) => sample.luminance);
    this.meanLuminance = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;
    const maxLuminance = Math.max(...luminances);

    // Square the weights so a single bright wall of signage wins over the
    // general glow, which is what gives readable directional shading.
    const direction = new THREE.Vector3();
    const keyColor = new THREE.Color(0, 0, 0);
    let weightTotal = 0;
    samples.forEach((sample, index) => {
      const weight = sample.luminance * sample.luminance;
      if (weight <= 0) return;
      direction.addScaledVector(FACE_DIRECTIONS[index], weight);
      keyColor.add(sample.color.clone().multiplyScalar(weight));
      weightTotal += weight;
    });

    if (weightTotal > 0 && direction.lengthSq() > 1e-6) {
      // Keep the key above the horizon: a light from below reads as broken.
      direction.normalize();
      direction.y = Math.max(direction.y, 0.35);
      this.keyDirection.copy(direction).normalize();
      keyColor.multiplyScalar(1 / weightTotal);
      normalizeBrightness(keyColor);
      this.key.color.copy(keyColor);
    }

    this.key.position.copy(this.keyDirection).multiplyScalar(10);

    const sky = samples[SKY_FACE].color.clone();
    const ground = samples[GROUND_FACE].color.clone();
    normalizeBrightness(sky);
    normalizeBrightness(ground);
    this.hemisphere.color.copy(sky);
    this.hemisphere.groundColor.copy(ground);

    const deficit = Math.max(0, LIFT_BELOW_LUMINANCE - this.meanLuminance) / LIFT_BELOW_LUMINANCE;
    this.exposureLift = 1 + (MAX_LIFT - 1) * deficit;
    this.keyIntensity = THREE.MathUtils.clamp(
      2.4 * maxLuminance * this.exposureLift,
      MIN_KEY_INTENSITY,
      MAX_KEY_INTENSITY,
    );
    this.applyIntensity();
  }

  private applyIntensity(): void {
    this.scene.environmentIntensity = this.baked ? this.intensity * this.exposureLift : 0;
    this.hemisphere.intensity = this.baked
      ? BAKED_HEMISPHERE_INTENSITY * this.intensity * this.exposureLift
      : 1.4 * this.intensity;
    this.key.intensity = this.baked ? this.keyIntensity * this.intensity : 1.6 * this.intensity;
  }

  diagnostics(): EnvironmentDiagnostics {
    return {
      baked: this.baked,
      baking: this.baking,
      bakeCount: this.bakeCount,
      rejectedBakes: this.rejectedBakes,
      lastBakeMs: Math.round(this.lastBakeMs),
      intensity: this.intensity,
      keyColor: `#${this.key.color.getHexString()}`,
      keyIntensity: this.key.intensity,
      keyDirection: {
        x: this.keyDirection.x,
        y: this.keyDirection.y,
        z: this.keyDirection.z,
      },
      skyColor: `#${this.hemisphere.color.getHexString()}`,
      groundColor: `#${this.hemisphere.groundColor.getHexString()}`,
      meanLuminance: this.meanLuminance,
      exposureLift: this.exposureLift,
    };
  }

  dispose(): void {
    this.scene.environment = null;
    this.envMap?.dispose();
    this.envMap = null;
    this.pmrem.dispose();
    this.scene.remove(this.hemisphere);
    this.scene.remove(this.key);
    this.hemisphere.dispose();
    this.key.dispose();
  }
}

function sampleFace(pixels: Uint8Array): FaceSample {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const step = 4 * PIXEL_STRIDE;
  for (let i = 0; i < pixels.length; i += step) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
    count += 1;
  }
  if (count === 0) return { color: new THREE.Color(0, 0, 0), luminance: 0 };
  const scale = 1 / (count * 255);
  const color = new THREE.Color(r * scale, g * scale, b * scale);
  return { color, luminance: 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b };
}

/** Rescales a color to full brightness so it contributes hue, not exposure. */
function normalizeBrightness(color: THREE.Color): void {
  const peak = Math.max(color.r, color.g, color.b);
  if (peak > 1e-4) color.multiplyScalar(1 / peak);
  else color.setRGB(1, 1, 1);
}
