import * as THREE from 'three';

const ORBIT_SENSITIVITY = 0.0052;
const ZOOM_SENSITIVITY = 0.0016;
const MIN_PITCH = -0.1;
const MAX_PITCH = 1.25;
const MIN_DISTANCE = 1.8;
const MAX_DISTANCE = 9;
const FOLLOW_LAMBDA = 10;
const HEAD_OFFSET = 1.5;
/**
 * Auto-orbit rates in radians per second, slowest first. The first is about a
 * lap every 25 s, which reads as a deliberate camera move rather than a spin.
 */
const AUTO_ORBIT_SPEEDS = [0.25, 0.5, 0.95, 1.6];
/** A drag this small is a click or a jitter, not an intent to take the camera. */
const DRAG_CANCEL_THRESHOLD = 2;

export type OrbitDirection = -1 | 1;

/** Smoothed third-person follow camera orbiting the character. */
export class ThirdPersonCamera {
  yaw = 0;
  pitch = 0.32;
  distance = 4.2;

  private autoOrbit = false;
  private orbitDirection: OrbitDirection = 1;
  private orbitSpeedIndex = 0;
  /**
   * Movement stays keyed to the angle the camera held when the orbit started.
   * WASD is camera-relative, so letting the basis rotate with the orbit would
   * make a held W walk the character in a circle.
   */
  private frozenMovementYaw = 0;

  private readonly followTarget = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** Yaw the movement basis should use; frozen while auto-orbiting. */
  get movementYaw(): number {
    return this.autoOrbit ? this.frozenMovementYaw : this.yaw;
  }

  get autoOrbitEnabled(): boolean {
    return this.autoOrbit;
  }

  /** Signed rate in rad/s, 0 when the orbit is off. */
  get autoOrbitSpeed(): number {
    return this.autoOrbit ? AUTO_ORBIT_SPEEDS[this.orbitSpeedIndex] * this.orbitDirection : 0;
  }

  setAutoOrbit(enabled: boolean): void {
    if (enabled === this.autoOrbit) return;
    this.autoOrbit = enabled;
    if (enabled) this.frozenMovementYaw = this.yaw;
  }

  toggleAutoOrbit(): boolean {
    this.setAutoOrbit(!this.autoOrbit);
    return this.autoOrbit;
  }

  /**
   * Steers the orbit. Pressing toward the current direction winds the speed up
   * a step; pressing against it turns the camera around at the slowest rate, so
   * one key both reverses and accelerates without a separate speed control.
   */
  steerAutoOrbit(direction: OrbitDirection): void {
    if (this.autoOrbit && direction === this.orbitDirection) {
      this.orbitSpeedIndex = Math.min(this.orbitSpeedIndex + 1, AUTO_ORBIT_SPEEDS.length - 1);
    } else {
      this.orbitDirection = direction;
      this.orbitSpeedIndex = 0;
    }
    this.setAutoOrbit(true);
  }

  snapTo(position: THREE.Vector3): void {
    this.followTarget.copy(position).y += HEAD_OFFSET;
    this.applyPosition(1);
  }

  update(
    delta: number,
    position: THREE.Vector3,
    orbitDelta: THREE.Vector2,
    zoomDelta: number,
  ): void {
    // Taking hold of the camera by hand ends the auto-orbit outright, so the
    // two never fight over the yaw.
    if (this.autoOrbit && orbitDelta.lengthSq() > DRAG_CANCEL_THRESHOLD ** 2) {
      this.setAutoOrbit(false);
    }
    if (this.autoOrbit) this.yaw += this.autoOrbitSpeed * delta;

    this.yaw -= orbitDelta.x * ORBIT_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + orbitDelta.y * ORBIT_SENSITIVITY,
      MIN_PITCH,
      MAX_PITCH,
    );
    this.distance = THREE.MathUtils.clamp(
      this.distance * (1 + zoomDelta * ZOOM_SENSITIVITY),
      MIN_DISTANCE,
      MAX_DISTANCE,
    );

    const target = position.clone();
    target.y += HEAD_OFFSET;
    const lerp = 1 - Math.exp(-FOLLOW_LAMBDA * delta);
    this.followTarget.lerp(target, lerp);
    this.applyPosition(lerp);
  }

  private applyPosition(_lerp: number): void {
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).multiplyScalar(this.distance);
    this.desired.copy(this.followTarget).add(offset);
    this.camera.position.copy(this.desired);
    this.camera.lookAt(this.followTarget);
  }
}
