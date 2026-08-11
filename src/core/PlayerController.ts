import * as THREE from 'three';
import type { GroundSampler } from '../world/SplatGround';

const WALK_SPEED = 2.0;
const RUN_SPEED = 4.8;
const ACCELERATION = 14;
const GRAVITY = 16;
const JUMP_SPEED = 6.2;
const TURN_LERP = 12;
const EYE_RAY_HEIGHT = 1.5;
const GROUND_SNAP = 0.3;
const WALL_CHECK_HEIGHT = 0.9;
const WALL_CHECK_DISTANCE = 0.45;
const FALL_RESET_Y = -30;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Kinematic character controller: camera-relative movement with gravity and
 * ground/wall raycasts against the invisible world collider meshes.
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  yaw = 0;
  velocityY = 0;
  grounded = false;
  horizontalSpeed = 0;
  /** Lifts the character above the collider so feet rest on the visible splat surface. */
  groundOffset = 0;
  /** True only on the frame a jump actually launches. */
  justJumped = false;
  /** Corrected surface point directly below the character, for the contact shadow. */
  readonly groundPoint = new THREE.Vector3();
  /** World-space normal of that surface. */
  readonly groundNormal = new THREE.Vector3(0, 1, 0);
  /** Distance from the feet to the surface below them. */
  heightAboveGround = 0;
  /** Ground for worlds with no collider mesh; the splats themselves. */
  groundSampler: GroundSampler | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly horizontalVelocity = new THREE.Vector3();
  private readonly spawnPoint = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly scratchNormal = new THREE.Vector3(0, 1, 0);

  /** Places the player on the ground nearest the world origin. */
  spawn(colliders: THREE.Object3D[]): void {
    let surfaceY: number | null = null;
    if (colliders.length > 0) {
      surfaceY = this.raycastDown(new THREE.Vector3(0, 8, 0), 24, colliders)?.point.y ?? null;
    } else {
      surfaceY = this.groundSampler?.heightAt(0, 0) ?? null;
    }
    this.spawnPoint.set(0, (surfaceY ?? 0) + this.groundOffset, 0);
    this.resetToSpawn();
  }

  /** Collider surface height directly below a world XZ position, if any. */
  sampleColliderHeight(x: number, z: number, colliders: THREE.Object3D[]): number | null {
    const hit = this.raycastDown(new THREE.Vector3(x, 12, z), 40, colliders);
    return hit ? hit.point.y : null;
  }

  resetToSpawn(): void {
    this.position.copy(this.spawnPoint);
    this.velocityY = 0;
    this.horizontalVelocity.set(0, 0, 0);
    this.horizontalSpeed = 0;
    this.grounded = true;
    this.groundPoint.copy(this.spawnPoint);
    this.groundNormal.set(0, 1, 0);
    this.heightAboveGround = 0;
  }

  update(
    delta: number,
    moveInput: THREE.Vector2,
    runHeld: boolean,
    jumpRequested: boolean,
    cameraYaw: number,
    colliders: THREE.Object3D[],
  ): void {
    // Camera-relative planar direction: input y is forward, x is strafe.
    const targetSpeed = moveInput.lengthSq() > 0 ? (runHeld ? RUN_SPEED : WALK_SPEED) : 0;
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    const direction = new THREE.Vector3(
      moveInput.x * cos - moveInput.y * sin,
      0,
      -moveInput.y * cos - moveInput.x * sin,
    );
    if (direction.lengthSq() > 1) direction.normalize();

    const targetVelocity = direction.multiplyScalar(targetSpeed);
    const lerp = 1 - Math.exp(-ACCELERATION * delta);
    this.horizontalVelocity.lerp(targetVelocity, lerp);
    if (this.horizontalVelocity.lengthSq() < 1e-6) this.horizontalVelocity.set(0, 0, 0);
    this.horizontalSpeed = this.horizontalVelocity.length();

    if (this.horizontalSpeed > 0.15) {
      const targetYaw = Math.atan2(this.horizontalVelocity.x, this.horizontalVelocity.z);
      this.yaw = dampAngle(this.yaw, targetYaw, TURN_LERP, delta);
    }

    this.justJumped = false;
    if (jumpRequested && this.grounded) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
      this.justJumped = true;
    }

    // Block horizontal motion into nearby walls at chest height.
    const step = this.horizontalVelocity.clone().multiplyScalar(delta);
    if (step.lengthSq() > 0 && colliders.length > 0) {
      const chest = this.position.clone().setY(this.position.y + WALL_CHECK_HEIGHT);
      const stepDirection = step.clone().normalize();
      this.raycaster.set(chest, stepDirection);
      this.raycaster.far = WALL_CHECK_DISTANCE + step.length();
      const hits = this.raycaster.intersectObjects(colliders, false);
      const blocking = hits.find((hit) => hit.distance < WALL_CHECK_DISTANCE + step.length());
      if (blocking) {
        const allowed = Math.max(0, blocking.distance - WALL_CHECK_DISTANCE);
        step.copy(stepDirection).multiplyScalar(Math.min(step.length(), allowed));
      }
    }
    this.position.add(step);

    this.velocityY -= GRAVITY * delta;
    this.position.y += this.velocityY * delta;

    this.settleOnGround(delta, colliders);

    if (this.position.y < FALL_RESET_Y) this.resetToSpawn();
  }

  private settleOnGround(delta: number, colliders: THREE.Object3D[]): void {
    if (colliders.length === 0) {
      const sampled = this.groundSampler?.heightAt(this.position.x, this.position.z) ?? null;
      if (sampled === null) {
        // No collider and no surface reading yet: float at spawn height.
        if (this.position.y < this.spawnPoint.y) {
          this.position.y = this.spawnPoint.y;
          this.velocityY = 0;
          this.grounded = true;
        }
        return;
      }
      this.settleAt(sampled + this.groundOffset, UP);
      return;
    }

    const origin = this.position.clone().setY(this.position.y + EYE_RAY_HEIGHT);
    const hit = this.raycastDown(origin, EYE_RAY_HEIGHT + Math.abs(this.velocityY * delta) + 2, colliders);
    if (!hit) {
      this.grounded = false;
      return;
    }

    const groundY = hit.point.y + this.groundOffset;
    if (hit.face) {
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      this.scratchNormal.copy(hit.face.normal).applyMatrix3(this.normalMatrix).normalize();
      // Collider triangles can face either way; keep the shadow lying on top.
      if (this.scratchNormal.y < 0) this.scratchNormal.negate();
    } else {
      this.scratchNormal.copy(UP);
    }
    this.settleAt(groundY, this.scratchNormal, hit.point.x, hit.point.z);
  }

  /** Shared landing logic for collider hits and sampled splat heights. */
  private settleAt(groundY: number, normal: THREE.Vector3, x = this.position.x, z = this.position.z): void {
    this.groundPoint.set(x, groundY, z);
    this.groundNormal.copy(normal);
    this.heightAboveGround = this.position.y - groundY;

    const snapWindow = this.grounded ? GROUND_SNAP : 0.05;
    if (this.velocityY <= 0 && this.position.y <= groundY + snapWindow) {
      this.position.y = groundY;
      this.velocityY = 0;
      this.grounded = true;
    } else if (this.position.y > groundY + snapWindow) {
      this.grounded = false;
    }
  }

  private raycastDown(
    origin: THREE.Vector3,
    far: number,
    colliders: THREE.Object3D[],
  ): THREE.Intersection | null {
    this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    this.raycaster.far = far;
    const hits = this.raycaster.intersectObjects(colliders, false);
    return hits[0] ?? null;
  }
}

function dampAngle(current: number, target: number, lambda: number, delta: number): number {
  let difference = (target - current) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return current + difference * (1 - Math.exp(-lambda * delta));
}
