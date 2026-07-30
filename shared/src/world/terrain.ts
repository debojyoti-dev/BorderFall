import { Terrain, isWater } from '../enums/terrain.js';
import type { Rng } from '../utils/prng.js';
import { NoiseField } from './noise.js';

/**
 * Turns a set of Voronoi cells into a believable landscape.
 *
 * The pipeline is elevation → moisture → classification → hydrology, each stage
 * consuming only the previous one. Keeping them separate means a change to how
 * deserts are placed cannot accidentally alter where the coastline falls.
 */

export interface TerrainInput {
  readonly centroidX: Float32Array;
  readonly centroidY: Float32Array;
  readonly neighbours: Uint16Array;
  readonly neighbourOffsets: Uint32Array;
  readonly count: number;
  readonly width: number;
  readonly height: number;
}

export interface TerrainParams {
  readonly landRatio: number;
  readonly continentCount: number;
  readonly islandDensity: number;
  readonly mountainRatio: number;
}

export interface TerrainResult {
  readonly terrain: Uint8Array;
  readonly elevation: Float32Array;
  /** Landmass index per territory; `-1` for water. */
  readonly landmassId: Int16Array;
  readonly landmassSizes: Uint32Array;
}

export function classifyTerrain(
  input: TerrainInput,
  params: TerrainParams,
  rng: Rng,
): TerrainResult {
  const { count, width, height, centroidX, centroidY } = input;

  const elevationNoise = new NoiseField(rng.fork('elevation'));
  const moistureNoise = new NoiseField(rng.fork('moisture'));
  const mountainNoise = new NoiseField(rng.fork('mountains'));

  const elevation = computeElevation(
    centroidX,
    centroidY,
    count,
    width,
    height,
    params,
    elevationNoise,
    rng.fork('continents'),
  );

  const terrain = new Uint8Array(count);

  // Choose the sea level that yields the requested land ratio, rather than
  // hard-coding a threshold. Noise fields vary in their distribution from seed
  // to seed, so a fixed cutoff would give wildly different land coverage per
  // map — and `landRatio` would be a lie.
  const seaLevel = percentile(elevation, count, 1 - params.landRatio);

  const moistureScale = 2.5 / Math.max(width, height);
  const mountainScale = 3.5 / Math.max(width, height);

  /* Stage 1 — separate land from water. -------------------------------- */
  const landIds: number[] = [];
  for (let i = 0; i < count; i++) {
    if ((elevation[i] as number) < seaLevel) {
      terrain[i] = Terrain.Ocean;
    } else {
      landIds.push(i);
    }
  }

  /* Stage 2 — score every land cell for altitude and moisture. ---------- */
  const mountainScores = new Float64Array(landIds.length);
  const moistureScores = new Float64Array(landIds.length);

  for (let k = 0; k < landIds.length; k++) {
    const i = landIds[k] as number;
    const x = centroidX[i] as number;
    const y = centroidY[i] as number;

    // Normalise land elevation to 0-1 above sea level so the score does not
    // depend on where sea level happened to land.
    const landHeight = ((elevation[i] as number) - seaLevel) / Math.max(1e-6, 1 - seaLevel);
    const ridge = mountainNoise.ridged(x * mountainScale, y * mountainScale, 4);

    // Mountains need both altitude and a ridge crest, which is what makes them
    // form connected chains rather than scattered peaks.
    mountainScores[k] = landHeight * 0.65 + ridge * 0.35;
    moistureScores[k] = moistureNoise.fbm(x * moistureScale, y * moistureScale, 4);
  }

  /**
   * Stage 3 — derive thresholds from the distribution, not from constants.
   *
   * Both noise fields concentrate near their midpoint, so absolute cutoffs
   * ("mountain if score > 0.82") are crossed by almost nothing: an earlier
   * revision produced 0 % mountains and 0.1 % desert, leaving the map as
   * undifferentiated plains with no strategic terrain at all. Taking the top
   * N % of the actual distribution guarantees the requested proportions on
   * every seed — the same technique already used for sea level.
   */
  const mountainCut = percentileOf(mountainScores, 1 - params.mountainRatio * 0.35);
  const hillCut = percentileOf(mountainScores, 1 - params.mountainRatio);
  const aridCut = percentileOf(moistureScores, 0.24);
  const humidCut = percentileOf(moistureScores, 0.62);

  /* Stage 4 — classify. ------------------------------------------------- */
  for (let k = 0; k < landIds.length; k++) {
    const i = landIds[k] as number;
    const mountainScore = mountainScores[k] as number;

    // Relief wins over climate: an arctic peak is still a mountain.
    if (mountainScore >= mountainCut) {
      terrain[i] = Terrain.Mountain;
      continue;
    }
    if (mountainScore >= hillCut) {
      terrain[i] = Terrain.Hills;
      continue;
    }

    // Latitude band: 0 at the equator, 1 at either pole.
    const latitude = Math.abs((centroidY[i] as number) / height - 0.5) * 2;
    const moisture = moistureScores[k] as number;

    if (latitude > 0.78) {
      terrain[i] = Terrain.Tundra;
    } else if (moisture <= aridCut && latitude < 0.6) {
      terrain[i] = Terrain.Desert;
    } else if (moisture >= humidCut) {
      terrain[i] = Terrain.Forest;
    } else {
      terrain[i] = Terrain.Plains;
    }
  }

  markCoastlines(terrain, input);
  markLakes(terrain, input);

  const { landmassId, landmassSizes } = labelLandmasses(terrain, input);

  return { terrain, elevation, landmassId, landmassSizes };
}

/**
 * Elevation field: continental masks plus fractal detail, faded at the borders.
 *
 * Pure fBm produces land that runs off every edge of the map, which looks
 * arbitrary and — more importantly — denies the naval game any open water.
 * Seeding a handful of continent centres and applying a radial falloff gives
 * recognisable landmasses separated by navigable sea.
 */
function computeElevation(
  centroidX: Float32Array,
  centroidY: Float32Array,
  count: number,
  width: number,
  height: number,
  params: TerrainParams,
  noise: NoiseField,
  rng: Rng,
): Float32Array {
  const continentX = new Float32Array(params.continentCount);
  const continentY = new Float32Array(params.continentCount);
  const continentRadius = new Float32Array(params.continentCount);

  for (let c = 0; c < params.continentCount; c++) {
    // Keep centres away from the border so continents are not clipped in half.
    continentX[c] = rng.nextRange(width * 0.2, width * 0.8);
    continentY[c] = rng.nextRange(height * 0.2, height * 0.8);
    continentRadius[c] = rng.nextRange(0.22, 0.42) * Math.min(width, height);
  }

  const elevation = new Float32Array(count);
  const detailScale = 3.0 / Math.max(width, height);

  for (let i = 0; i < count; i++) {
    const x = centroidX[i] as number;
    const y = centroidY[i] as number;

    // Strongest continental influence wins, so overlapping continents merge
    // into one landmass instead of summing into an implausible plateau.
    let continentMask = 0;
    for (let c = 0; c < params.continentCount; c++) {
      const dx = x - (continentX[c] as number);
      const dy = y - (continentY[c] as number);
      const distance = Math.sqrt(dx * dx + dy * dy);
      const influence = 1 - distance / (continentRadius[c] as number);
      if (influence > continentMask) continentMask = influence;
    }
    continentMask = Math.max(0, Math.min(1, continentMask));
    // Smoothstep gives a soft shelf rather than a conical island.
    continentMask = continentMask * continentMask * (3 - 2 * continentMask);

    const detail = (noise.fbm(x * detailScale, y * detailScale, 6) + 1) * 0.5;

    // Border falloff: force the outer frame of the map to open ocean so the
    // playable area is bounded by water rather than by an invisible wall.
    const edgeX = Math.min(x, width - x) / (width * 0.5);
    const edgeY = Math.min(y, height - y) / (height * 0.5);
    const edge = Math.min(1, Math.min(edgeX, edgeY) / 0.18);

    // Islands: a little detail leaks through outside continents, so open ocean
    // is dotted with small landfalls worth contesting.
    const base = continentMask * 0.75 + detail * 0.25 * (1 + params.islandDensity);

    elevation[i] = base * edge;
  }

  return elevation;
}

/** Ocean cells touching land become Coast — where ports and landings happen. */
function markCoastlines(terrain: Uint8Array, input: TerrainInput): void {
  const { count, neighbours, neighbourOffsets } = input;

  for (let i = 0; i < count; i++) {
    if (terrain[i] !== Terrain.Ocean) continue;

    const end = neighbourOffsets[i + 1] as number;
    for (let k = neighbourOffsets[i] as number; k < end; k++) {
      const neighbour = neighbours[k] as number;
      if (!isWater(terrain[neighbour] as Terrain)) {
        terrain[i] = Terrain.Coast;
        break;
      }
    }
  }
}

/**
 * Reclassifies enclosed water as Lake.
 *
 * A flood fill inward from the map border marks everything reachable as sea;
 * whatever water remains is landlocked. The distinction is not cosmetic — sea
 * is one connected navigation graph for the naval game, and a fleet must not be
 * able to path through an inland lake to reach the far side of a continent.
 */
function markLakes(terrain: Uint8Array, input: TerrainInput): void {
  const { count, neighbours, neighbourOffsets, centroidX, centroidY, width, height } = input;

  const reachedFromBorder = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let head = 0;
  let tail = 0;

  // Seed with every water cell near the map border.
  const margin = Math.min(width, height) * 0.03;
  for (let i = 0; i < count; i++) {
    if (!isWater(terrain[i] as Terrain)) continue;
    const x = centroidX[i] as number;
    const y = centroidY[i] as number;
    if (x < margin || y < margin || x > width - margin || y > height - margin) {
      reachedFromBorder[i] = 1;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const current = queue[head++] as number;
    const end = neighbourOffsets[current + 1] as number;
    for (let k = neighbourOffsets[current] as number; k < end; k++) {
      const neighbour = neighbours[k] as number;
      if (reachedFromBorder[neighbour]) continue;
      if (!isWater(terrain[neighbour] as Terrain)) continue;
      reachedFromBorder[neighbour] = 1;
      queue[tail++] = neighbour;
    }
  }

  for (let i = 0; i < count; i++) {
    if (isWater(terrain[i] as Terrain) && !reachedFromBorder[i]) {
      terrain[i] = Terrain.Lake;
    }
  }
}

/**
 * Flood-fills connected land regions.
 *
 * Spawn placement uses this to avoid stranding a player on a two-cell island,
 * and the bot expansion heuristic uses it to recognise when it must go by sea.
 */
function labelLandmasses(
  terrain: Uint8Array,
  input: TerrainInput,
): { landmassId: Int16Array; landmassSizes: Uint32Array } {
  const { count, neighbours, neighbourOffsets } = input;

  const landmassId = new Int16Array(count).fill(-1);
  const sizes: number[] = [];
  const queue = new Uint32Array(count);

  for (let start = 0; start < count; start++) {
    if (landmassId[start] !== -1) continue;
    if (isWater(terrain[start] as Terrain)) continue;

    const id = sizes.length;
    let size = 0;
    let head = 0;
    let tail = 0;

    landmassId[start] = id;
    queue[tail++] = start;

    while (head < tail) {
      const current = queue[head++] as number;
      size++;

      const end = neighbourOffsets[current + 1] as number;
      for (let k = neighbourOffsets[current] as number; k < end; k++) {
        const neighbour = neighbours[k] as number;
        if (landmassId[neighbour] !== -1) continue;
        if (isWater(terrain[neighbour] as Terrain)) continue;
        landmassId[neighbour] = id;
        queue[tail++] = neighbour;
      }
    }

    sizes.push(size);
    // Int16 landmass ids cap at 32 767 regions, far beyond any real map.
    if (id >= 32_766) break;
  }

  return { landmassId, landmassSizes: Uint32Array.from(sizes) };
}

/**
 * Value at the given quantile of a Float32Array.
 *
 * Copies and sorts rather than using a selection algorithm: this runs once per
 * map generation on 5 000 elements, where the O(n log n) is immaterial and the
 * clarity is worth more.
 */
function percentile(values: Float32Array, count: number, quantile: number): number {
  if (count === 0) return 0;
  const sorted = Float32Array.prototype.slice.call(values, 0, count).sort();
  const index = Math.min(count - 1, Math.max(0, Math.floor(quantile * count)));
  return sorted[index] as number;
}

/** As {@link percentile}, over a whole Float64Array. */
function percentileOf(values: Float64Array, quantile: number): number {
  if (values.length === 0) return 0;
  // Float64Array.sort is numeric by default, unlike Array.prototype.sort.
  const sorted = values.slice().sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)));
  return sorted[index] as number;
}
