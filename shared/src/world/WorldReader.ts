import type { Terrain } from '../enums/terrain.js';
import { isLand, isWater } from '../enums/terrain.js';
import type { WorldGeometry } from '../interfaces/world.js';
import type { Point } from '../utils/math.js';
import { SpatialGrid } from './SpatialGrid.js';

/**
 * Ergonomic, allocation-conscious accessors over {@link WorldGeometry}'s CSR
 * arrays.
 *
 * The raw arrays are the right storage format and the wrong calling convention:
 * `geometry.neighbours[geometry.neighbourOffsets[id] + k]` at every call site is
 * both unreadable and easy to get subtly wrong. This wraps them without copying
 * anything.
 *
 * Note which methods allocate. `getPolygon` builds an array and is fine for a
 * one-off inspection; `forEachPolygonPoint` and `forEachNeighbour` allocate
 * nothing and are what the renderer and the simulation use in loops.
 */
export class WorldReader {
  private pickGrid: SpatialGrid | null = null;

  constructor(readonly geometry: WorldGeometry) {}

  get territoryCount(): number {
    return this.geometry.territoryCount;
  }

  get width(): number {
    return this.geometry.params.width;
  }

  get height(): number {
    return this.geometry.params.height;
  }

  isValidId(id: number): boolean {
    return Number.isInteger(id) && id >= 0 && id < this.geometry.territoryCount;
  }

  getTerrain(id: number): Terrain {
    return this.geometry.terrain[id] as Terrain;
  }

  isLand(id: number): boolean {
    return isLand(this.getTerrain(id));
  }

  isWater(id: number): boolean {
    return isWater(this.getTerrain(id));
  }

  getCentroid(id: number): Point {
    return { x: this.geometry.centroidX[id] as number, y: this.geometry.centroidY[id] as number };
  }

  getCentroidX(id: number): number {
    return this.geometry.centroidX[id] as number;
  }

  getCentroidY(id: number): number {
    return this.geometry.centroidY[id] as number;
  }

  getArea(id: number): number {
    return this.geometry.area[id] as number;
  }

  /** `[minX, minY, maxX, maxY]` for viewport culling and hit-test rejection. */
  getBounds(id: number): [number, number, number, number] {
    const base = id * 4;
    return [
      this.geometry.bounds[base] as number,
      this.geometry.bounds[base + 1] as number,
      this.geometry.bounds[base + 2] as number,
      this.geometry.bounds[base + 3] as number,
    ];
  }

  getVertexCount(id: number): number {
    return (
      ((this.geometry.polygonOffsets[id + 1] as number) -
        (this.geometry.polygonOffsets[id] as number)) /
      2
    );
  }

  /** Allocates. Use {@link forEachPolygonPoint} inside loops. */
  getPolygon(id: number): Point[] {
    const start = this.geometry.polygonOffsets[id] as number;
    const end = this.geometry.polygonOffsets[id + 1] as number;
    const points: Point[] = [];
    for (let k = start; k < end; k += 2) {
      points.push({
        x: this.geometry.polygonPoints[k] as number,
        y: this.geometry.polygonPoints[k + 1] as number,
      });
    }
    return points;
  }

  /** Allocation-free polygon iteration. */
  forEachPolygonPoint(id: number, visit: (x: number, y: number, index: number) => void): void {
    const start = this.geometry.polygonOffsets[id] as number;
    const end = this.geometry.polygonOffsets[id + 1] as number;
    let index = 0;
    for (let k = start; k < end; k += 2) {
      visit(
        this.geometry.polygonPoints[k] as number,
        this.geometry.polygonPoints[k + 1] as number,
        index++,
      );
    }
  }

  getNeighbourCount(id: number): number {
    return (
      (this.geometry.neighbourOffsets[id + 1] as number) -
      (this.geometry.neighbourOffsets[id] as number)
    );
  }

  getNeighbourAt(id: number, index: number): number {
    return this.geometry.neighbours[
      (this.geometry.neighbourOffsets[id] as number) + index
    ] as number;
  }

  /** Allocation-free adjacency iteration — the hot path for attack validation. */
  forEachNeighbour(id: number, visit: (neighbourId: number) => void): void {
    const end = this.geometry.neighbourOffsets[id + 1] as number;
    for (let k = this.geometry.neighbourOffsets[id] as number; k < end; k++) {
      visit(this.geometry.neighbours[k] as number);
    }
  }

  /**
   * Adjacency test. Scans `a`'s neighbour list, which is a contiguous read of
   * typically six to ten `Uint16` values — cheaper than any hash lookup.
   */
  areNeighbours(a: number, b: number): boolean {
    const end = this.geometry.neighbourOffsets[a + 1] as number;
    for (let k = this.geometry.neighbourOffsets[a] as number; k < end; k++) {
      if (this.geometry.neighbours[k] === b) return true;
    }
    return false;
  }

  /**
   * Territory containing the given world point, or `-1`.
   *
   * Nearest-centroid lookup rather than point-in-polygon testing: for a Voronoi
   * diagram those are the same answer by definition, and the nearest-site query
   * is O(1) expected against a spatial grid where polygon testing would be
   * O(n). The grid is built lazily so a headless server that never picks does
   * not pay for it.
   */
  pick(x: number, y: number): number {
    if (x < 0 || y < 0 || x > this.width || y > this.height) return -1;
    this.pickGrid ??= new SpatialGrid(
      this.geometry.centroidX,
      this.geometry.centroidY,
      this.width,
      this.height,
      this.geometry.territoryCount,
    );
    return this.pickGrid.findNearest(x, y);
  }

  /** Ids whose bounding box intersects the given rectangle. */
  queryBounds(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
    out.length = 0;
    const bounds = this.geometry.bounds;
    for (let i = 0; i < this.geometry.territoryCount; i++) {
      const base = i * 4;
      if ((bounds[base] as number) > maxX) continue;
      if ((bounds[base + 2] as number) < minX) continue;
      if ((bounds[base + 1] as number) > maxY) continue;
      if ((bounds[base + 3] as number) < minY) continue;
      out.push(i);
    }
    return out;
  }

  /** Count of land territories — the denominator for territory-share scoring. */
  countLandTerritories(): number {
    let total = 0;
    for (let i = 0; i < this.geometry.territoryCount; i++) {
      if (isLand(this.geometry.terrain[i] as Terrain)) total++;
    }
    return total;
  }
}
