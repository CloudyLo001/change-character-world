import * as THREE from 'three';
import type { MintWorldManager } from './MintWorld';

const CELL_SIZE = 1;
const SAMPLE_RADIUS_CELLS = 2;
const SAMPLES_PER_FRAME = 1;
const PROBE_ABOVE = 2.5;
const PROBE_REACH = 4;
const MAX_CACHE_CELLS = 4096;

export interface GroundSampler {
  heightAt(x: number, z: number): number | null;
}

function cellKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/**
 * Ground for worlds that arrive without a collider — an uploaded RAD/SPZ/PLY is
 * just splats, with no collision mesh to stand on. Splat raycasting is a CPU
 * walk over resident splats, far too slow per frame, so heights are sampled on
 * a coarse grid around the character, a couple of cells at a time, and cached.
 */
export class SplatGround implements GroundSampler {
  private readonly heights = new Map<string, number | null>();
  private readonly queue: Array<{ cx: number; cz: number }> = [];
  private queued = new Set<string>();
  private lastKnownHeight: number | null = null;

  constructor(private readonly worlds: MintWorldManager) {}

  reset(): void {
    this.heights.clear();
    this.queue.length = 0;
    this.queued.clear();
    this.lastKnownHeight = null;
  }

  /** Queues nearby cells and samples a couple of them; call once per frame. */
  update(position: THREE.Vector3): void {
    if (!this.worlds.usesSplatGround) return;

    const cx = Math.round(position.x / CELL_SIZE);
    const cz = Math.round(position.z / CELL_SIZE);
    for (let dz = -SAMPLE_RADIUS_CELLS; dz <= SAMPLE_RADIUS_CELLS; dz += 1) {
      for (let dx = -SAMPLE_RADIUS_CELLS; dx <= SAMPLE_RADIUS_CELLS; dx += 1) {
        const key = cellKey(cx + dx, cz + dz);
        if (this.heights.has(key) || this.queued.has(key)) continue;
        this.queued.add(key);
        this.queue.push({ cx: cx + dx, cz: cz + dz });
      }
    }

    // Nearest-first so the cell under the character resolves before its
    // neighbours when the player has just moved or spawned.
    this.queue.sort(
      (a, b) => (a.cx - cx) ** 2 + (a.cz - cz) ** 2 - ((b.cx - cx) ** 2 + (b.cz - cz) ** 2),
    );

    for (let i = 0; i < SAMPLES_PER_FRAME && this.queue.length > 0; i += 1) {
      const cell = this.queue.shift();
      if (!cell) break;
      const key = cellKey(cell.cx, cell.cz);
      this.queued.delete(key);
      this.heights.set(key, this.probe(cell.cx, cell.cz, position.y));
    }

    if (this.heights.size > MAX_CACHE_CELLS) this.trim(cx, cz);
  }

  heightAt(x: number, z: number): number | null {
    if (!this.worlds.usesSplatGround) return null;
    const cx = Math.round(x / CELL_SIZE);
    const cz = Math.round(z / CELL_SIZE);

    const exact = this.heights.get(cellKey(cx, cz));
    if (exact !== undefined && exact !== null) {
      this.lastKnownHeight = exact;
      return exact;
    }

    // Fall back to the average of whatever neighbours have resolved, so a gap
    // in the samples does not drop the character through the floor.
    let sum = 0;
    let count = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const value = this.heights.get(cellKey(cx + dx, cz + dz));
        if (value !== undefined && value !== null) {
          sum += value;
          count += 1;
        }
      }
    }
    if (count > 0) {
      const average = sum / count;
      this.lastKnownHeight = average;
      return average;
    }
    return this.lastKnownHeight;
  }

  private probe(cx: number, cz: number, nearY: number): number | null {
    const from = this.lastKnownHeight ?? nearY;
    return this.worlds.sampleSplatHeight(cx * CELL_SIZE, cz * CELL_SIZE, from, PROBE_ABOVE) ??
      this.worlds.sampleSplatHeight(cx * CELL_SIZE, cz * CELL_SIZE, from, PROBE_REACH);
  }

  /** Drops the cells furthest from the character once the cache grows large. */
  private trim(cx: number, cz: number): void {
    const entries = [...this.heights.keys()]
      .map((key) => {
        const [x, z] = key.split(',').map(Number);
        return { key, distance: (x - cx) ** 2 + (z - cz) ** 2 };
      })
      .sort((a, b) => b.distance - a.distance);
    for (let i = 0; i < entries.length / 2; i += 1) this.heights.delete(entries[i].key);
  }
}
