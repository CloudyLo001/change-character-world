/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  score: number;
  targetScore: number;
  complete: boolean;
  player: {
    position: { x: number; y: number; z: number };
    speed: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
  world: string | null;
  character: string | null;
  environment: {
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
  };
  grounding: {
    offset: number;
    offsetSource: string;
    grounded: boolean;
    heightAboveGround: number;
    footCorrection: number;
    calibrationSamples: number[];
    calibrationNote: string;
    armTuckTarget: number;
    armSpread: {
      leftBefore: number;
      rightBefore: number;
      leftAfter: number;
      rightAfter: number;
      bones: number;
    };
    shadowVisible: boolean;
    shadowOpacity: number;
  };
}

interface ThreeGameTestHooks {
  /** Re-seed the game RNG; all gameplay randomness must flow through it. */
  seed(value: number): void;
  /** Jump to a named state for baselines (scaffold: 'active-play' | 'complete'). */
  setState(name: string): void;
  /** Freeze the simulation while continuing to render the current frame. */
  setPausedForScreenshot(paused: boolean): void;
  /** Freeze ambient/idle animation time so screenshots are stable. */
  setReducedMotion(enabled: boolean): void;
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void;
  /** Advance the simulation without rAF, for deterministic headless checks. */
  step(frames?: number, delta?: number): void;
  /** Bone names and detected arm chain of the active character, or null. */
  describeRig(): { bones: string[]; arms: Array<{ side: string; bone: string; elbow: string }> } | null;
  /** Raw collider vs visible-splat surface heights, for grounding diagnosis. */
  probeGround(
    x: number,
    z: number,
    fromY: number,
    reach: number,
  ): { collider: number | null; splat: number | null };
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
