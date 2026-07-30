import type { Terrain } from '../enums/terrain.js';
import type { Point } from '../utils/math.js';

/**
 * The *static* half of the world: geometry and topology that are fixed for the
 * lifetime of a match.
 *
 * This split is the single most important data-modelling decision in the
 * project. Static data is generated deterministically from a seed on both the
 * server and every client, so it is **never transmitted** — a 5 000-territory
 * world costs 4 bytes on the wire instead of roughly 2 MB of polygon vertices.
 * Dynamic data (see `TerritoryStateView`) is the only thing that flows over the
 * network, and it is small enough to delta-encode at 20 Hz for 200 players.
 */

/** Inputs that fully determine a world. Two identical params ⇒ identical maps. */
export interface MapGenParams {
  /** 32-bit seed. The only value the server sends to describe the entire map. */
  readonly seed: number;
  /** Target number of Voronoi cells. Actual count may differ by a few. */
  readonly territoryCount: number;
  readonly width: number;
  readonly height: number;
  /** Fraction of cells that should end up as land, 0–1. */
  readonly landRatio: number;
  /** Number of continental seeds. Higher values fragment the map. */
  readonly continentCount: number;
  /** Probability weight for scattering small offshore islands. */
  readonly islandDensity: number;
  /** Fraction of land that becomes mountain/hill terrain. */
  readonly mountainRatio: number;
  /** Lloyd relaxation passes. More passes ⇒ rounder, more uniform cells. */
  readonly relaxationPasses: number;
}

/**
 * Immutable world geometry.
 *
 * Stored as parallel typed arrays (structure-of-arrays) rather than an array of
 * objects. At 5 000+ territories, an AoS layout costs one pointer dereference
 * and one cache miss per territory per frame; SoA lets the renderer and the
 * simulation stream contiguous memory. It also makes the whole world trivially
 * transferable to a Web Worker via `postMessage` with zero copying.
 */
export interface WorldGeometry {
  readonly params: MapGenParams;
  readonly territoryCount: number;

  /** Area-weighted centroid, used for labels, army markers and distance checks. */
  readonly centroidX: Float32Array;
  readonly centroidY: Float32Array;

  /** Terrain classification per territory. */
  readonly terrain: Uint8Array;

  /** Cell area in world units squared. Feeds population capacity. */
  readonly area: Float32Array;

  /**
   * Polygon vertices, flattened.
   *
   * `polygonOffsets[i] .. polygonOffsets[i + 1]` indexes into `polygonPoints`
   * as `[x0, y0, x1, y1, ...]` — the standard CSR (compressed sparse row)
   * layout. One allocation for the whole map instead of 5 000 small arrays,
   * which matters enormously for GC pressure during generation.
   */
  readonly polygonPoints: Float32Array;
  readonly polygonOffsets: Uint32Array;

  /**
   * Neighbour adjacency in the same CSR form:
   * `neighbours[neighbourOffsets[i] .. neighbourOffsets[i + 1]]`.
   *
   * Adjacency is queried on every attack validation and every bot decision.
   * CSR keeps that an O(degree) contiguous scan with no allocation, versus a
   * `Map<number, number[]>` which allocates and pointer-chases.
   */
  readonly neighbours: Uint16Array;
  readonly neighbourOffsets: Uint32Array;

  /** Territory ids that are valid spawn points, precomputed at generation. */
  readonly spawnCandidates: Uint16Array;

  /** Bounding box per territory, flattened as `[minX, minY, maxX, maxY]`. */
  readonly bounds: Float32Array;
}

/** Convenience accessors over {@link WorldGeometry}'s CSR arrays. */
export interface WorldGeometryReader {
  readonly geometry: WorldGeometry;
  getTerrain(id: number): Terrain;
  getCentroid(id: number): Point;
  /** Copies the polygon into a fresh array. Prefer `forEachPolygonPoint` in loops. */
  getPolygon(id: number): Point[];
  getNeighbourCount(id: number): number;
  /** Reads a single neighbour without allocating. */
  getNeighbourAt(id: number, index: number): number;
  areNeighbours(a: number, b: number): boolean;
}

/** Continent/island labelling produced during generation, useful for bots and spawns. */
export interface LandmassInfo {
  /** Landmass index per territory; `-1` for water. */
  readonly landmassId: Int16Array;
  /** Territory count per landmass, indexed by landmass id. */
  readonly landmassSizes: Uint32Array;
}
