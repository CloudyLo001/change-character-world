import * as THREE from 'three';
import { disposeObject3D } from '../utils/dispose';

const TEXTURE_SIZE = 128;
const BASE_RADIUS = 0.62;
const SURFACE_LIFT = 0.02;
const MAX_STRETCH = 1.9;
const FADE_HEIGHT = 2.2;
const GROW_WITH_HEIGHT = 0.55;
const FOLLOW_LAMBDA = 18;

/**
 * A soft blob under the character. Splats cannot receive shadow maps and the
 * world collider sits below the visible surface, so a real shadow pass would
 * land underneath the road. This decal is placed at the same corrected ground
 * point the feet use, and leans away from the derived key light so it reads as
 * cast by the light that is actually lighting the character.
 */
export class ContactShadow {
  readonly mesh: THREE.Mesh;

  private readonly baseOpacity: number;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly target = new THREE.Vector3();
  private readonly axisX = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();

  constructor(opacity = 0.55) {
    this.baseOpacity = opacity;
    // Bake the lie-flat rotation into the geometry so the mesh's local X and Z
    // are the ground-plane axes and scaling can follow the light direction.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.MeshBasicMaterial({
      map: createRadialTexture(),
      color: 0x000000,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    // Splats never write depth, so draw the decal after them to keep it visible
    // on the road surface.
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  setOpacity(value: number): void {
    this.material.opacity = THREE.MathUtils.clamp(value, 0, 1);
  }

  get opacity(): number {
    return this.baseOpacity;
  }

  /**
   * @param groundPoint corrected ground contact position (same Y as the feet)
   * @param groundNormal world-space surface normal under the character
   * @param heightAboveGround how far the character has left the ground
   * @param keyDirection unit vector pointing toward the dominant light
   */
  update(
    delta: number,
    groundPoint: THREE.Vector3,
    groundNormal: THREE.Vector3,
    heightAboveGround: number,
    keyDirection: THREE.Vector3,
  ): void {
    const height = Math.max(0, heightAboveGround);
    const fade = 1 - THREE.MathUtils.clamp(height / FADE_HEIGHT, 0, 1);
    if (fade <= 0.001) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    // Local X follows the light's ground-plane direction so the blob can be
    // stretched along it; a low light casts a longer shadow than a high one.
    this.axisX.copy(keyDirection).projectOnPlane(groundNormal);
    if (this.axisX.lengthSq() < 1e-6) this.axisX.set(1, 0, 0).projectOnPlane(groundNormal);
    this.axisX.normalize();
    this.axisZ.copy(this.axisX).cross(groundNormal).normalize();
    this.basis.makeBasis(this.axisX, groundNormal, this.axisZ);
    this.mesh.quaternion.setFromRotationMatrix(this.basis);

    const stretch = 1 + (MAX_STRETCH - 1) * (1 - Math.abs(keyDirection.y));
    const radius = BASE_RADIUS * (1 + GROW_WITH_HEIGHT * (height / FADE_HEIGHT));

    this.target.copy(groundPoint);
    this.target.addScaledVector(this.axisX, -radius * 0.45 * (stretch - 1));
    this.target.addScaledVector(groundNormal, SURFACE_LIFT);

    const lerp = 1 - Math.exp(-FOLLOW_LAMBDA * delta);
    this.mesh.position.lerp(this.target, lerp);
    this.mesh.scale.set(radius * 2 * stretch, 1, radius * 2);
    this.material.opacity = this.baseOpacity * fade * fade;
  }

  snapTo(groundPoint: THREE.Vector3): void {
    this.mesh.position.copy(groundPoint);
  }

  dispose(): void {
    disposeObject3D(this.mesh);
  }
}

function createRadialTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create contact shadow texture context.');

  const half = TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.72)');
  gradient.addColorStop(0.75, 'rgba(255, 255, 255, 0.22)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
