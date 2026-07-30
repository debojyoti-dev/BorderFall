import {
  DEFAULT_TERRITORY_COUNT,
  MIN_TERRITORY_COUNT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../constants/engine.js';
import { isLand } from '../enums/terrain.js';
import type { MapGenParams, WorldGeometry } from '../interfaces/world.js';
import { Rng } from '../utils/prng.js';
import { poissonDiscSample, radiusForCount } from './poisson.js';
import { classifyTerrain } from './terrain.js';
import { buildVoronoi, relaxSites } from './voronoi.js';

/**
 * The deterministic world generator.
 *
 * **This function is the whole map-replication strategy.** The server picks a
 * seed and sends 4 bytes; every client calls this and reconstructs a
 * bit-identical 5 000-territory world locally. Sending the generated geometry
 * instead would cost roughly 2 MB per player on join.
 *
 * That only holds if the function is *exactly* reproducible, so it may use no
 * ambient randomness, no wall clock, and no floating-point operation whose
 * result varies across JavaScript engines. Every random draw comes from the
 * seeded {@link Rng}, and each stage takes a named fork so that adding a draw
 * to one stage cannot shift the stream another stage observes.
 */

export const DEFAULT_MAP_PARAMS: Omit<MapGenParams, 'seed'> = {
  territoryCount: DEFAULT_TERRITORY_COUNT,
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  landRatio: 0.42,
  continentCount: 4,
  islandDensity: 0.35,
  mountainRatio: 0.18,
  relaxationPasses: 2,
};

export function createMapParams(seed: number, overrides: Partial<MapGenParams> = {}): MapGenParams {
  const merged = { ...DEFAULT_MAP_PARAMS, ...overrides, seed };
  return {
    ...merged,
    territoryCount: Math.max(MIN_TERRITORY_COUNT, Math.floor(merged.territoryCount)),
    landRatio: clamp(merged.landRatio, 0.1, 0.9),
    continentCount: Math.max(1, Math.floor(merged.continentCount)),
    relaxationPasses: Math.max(0, Math.min(6, Math.floor(merged.relaxationPasses))),
  };
}

export function generateWorld(params: MapGenParams): WorldGeometry {
  const rng = new Rng(params.seed);

  /* 1 — Site placement -------------------------------------------------- */
  const radius = radiusForCount(params.width, params.height, params.territoryCount);
  const sample = poissonDiscSample(params.width, params.height, radius, rng.fork('sites'));

  // Copy out of the subarray view: `relaxSites` writes in place, and the
  // sampler's backing buffer is larger than the used range.
  const xs = Float32Array.from(sample.xs);
  const ys = Float32Array.from(sample.ys);
  const count = sample.count;

  /* 2 — Lloyd relaxation ------------------------------------------------ */
  // Regularises cell shape so territories are comparable in size and pleasant
  // to click. Two passes is the sweet spot; more converges toward a hex grid.
  for (let pass = 0; pass < params.relaxationPasses; pass++) {
    relaxSites(xs, ys, count, params.width, params.height);
  }

  /* 3 — Final diagram --------------------------------------------------- */
  const voronoi = buildVoronoi(xs, ys, count, params.width, params.height);

  /* 4 — Terrain --------------------------------------------------------- */
  const terrainResult = classifyTerrain(
    {
      centroidX: voronoi.centroidX,
      centroidY: voronoi.centroidY,
      neighbours: voronoi.neighbours,
      neighbourOffsets: voronoi.neighbourOffsets,
      count,
      width: params.width,
      height: params.height,
    },
    {
      landRatio: params.landRatio,
      continentCount: params.continentCount,
      islandDensity: params.islandDensity,
      mountainRatio: params.mountainRatio,
    },
    rng.fork('terrain'),
  );

  /* 5 — Derived data ---------------------------------------------------- */
  const bounds = computeBounds(voronoi.polygonPoints, voronoi.polygonOffsets, count);
  const spawnCandidates = selectSpawnCandidates(
    terrainResult.terrain,
    terrainResult.landmassId,
    terrainResult.landmassSizes,
    voronoi.centroidX,
    voronoi.centroidY,
    count,
  );

  return {
    params,
    territoryCount: count,
    centroidX: voronoi.centroidX,
    centroidY: voronoi.centroidY,
    terrain: terrainResult.terrain,
    area: voronoi.area,
    polygonPoints: voronoi.polygonPoints,
    polygonOffsets: voronoi.polygonOffsets,
    neighbours: voronoi.neighbours,
    neighbourOffsets: voronoi.neighbourOffsets,
    spawnCandidates,
    bounds,
  };
}

/** Axis-aligned bounding box per territory, flattened `[minX, minY, maxX, maxY]`. */
function computeBounds(
  polygonPoints: Float32Array,
  polygonOffsets: Uint32Array,
  count: number,
): Float32Array {
  const bounds = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const start = polygonOffsets[i] as number;
    const end = polygonOffsets[i + 1] as number;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let k = start; k < end; k += 2) {
      const x = polygonPoints[k] as number;
      const y = polygonPoints[k + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // Degenerate polygon: collapse the box to the origin rather than leaving
    // infinities, which would poison every downstream intersection test.
    if (start === end) {
      minX = minY = maxX = maxY = 0;
    }

    bounds[i * 4] = minX;
    bounds[i * 4 + 1] = minY;
    bounds[i * 4 + 2] = maxX;
    bounds[i * 4 + 3] = maxY;
  }

  return bounds;
}

/**
 * Picks territories suitable as starting positions.
 *
 * Two requirements, both learned the hard way in this genre: a spawn must sit
 * on a landmass big enough to expand into (otherwise the player is eliminated
 * by geography, not by an opponent), and spawns must be spread out (otherwise
 * two neighbours fight to the death in the first thirty seconds while everyone
 * else develops unopposed).
 *
 * Greedy farthest-point selection satisfies the second cheaply: repeatedly take
 * the candidate maximising distance to the nearest already-chosen spawn.
 */
function selectSpawnCandidates(
  terrain: Uint8Array,
  landmassId: Int16Array,
  landmassSizes: Uint32Array,
  centroidX: Float32Array,
  centroidY: Float32Array,
  count: number,
): Uint16Array {
  // A landmass must support a few territories of expansion to be viable.
  const minimumLandmassSize = 8;

  const eligible: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!isLand(terrain[i] as never)) continue;
    const mass = landmassId[i] as number;
    if (mass < 0) continue;
    if ((landmassSizes[mass] as number) < minimumLandmassSize) continue;
    eligible.push(i);
  }

  if (eligible.length === 0) return new Uint16Array(0);

  // Cap the pool: matchmaking only ever needs a few hundred, and the greedy
  // selection below is O(pool × selected).
  const target = Math.min(eligible.length, 512);
  const selected: number[] = [];

  // Deterministic seed for the greedy pass: the lowest eligible index. Using a
  // random start would still be reproducible, but this keeps spawn sets stable
  // across changes to unrelated RNG consumers.
  selected.push(eligible[0] as number);

  const nearestDistanceSq = new Float64Array(eligible.length).fill(Infinity);

  while (selected.length < target) {
    const last = selected[selected.length - 1] as number;
    const lx = centroidX[last] as number;
    const ly = centroidY[last] as number;

    let bestIndex = -1;
    let bestDistance = -1;

    for (let k = 0; k < eligible.length; k++) {
      const candidate = eligible[k] as number;
      const dx = (centroidX[candidate] as number) - lx;
      const dy = (centroidY[candidate] as number) - ly;
      const distSq = dx * dx + dy * dy;

      // Maintain the running "distance to nearest chosen" incrementally, which
      // keeps the whole selection O(pool × selected) instead of cubic.
      if (distSq < (nearestDistanceSq[k] as number)) nearestDistanceSq[k] = distSq;

      const current = nearestDistanceSq[k] as number;
      if (current > bestDistance) {
        bestDistance = current;
        bestIndex = k;
      }
    }

    if (bestIndex < 0 || bestDistance <= 0) break;
    selected.push(eligible[bestIndex] as number);
    nearestDistanceSq[bestIndex] = 0;
  }

  return Uint16Array.from(selected);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
