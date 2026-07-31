import { Rng } from '../utils/prng.js';
import { NoiseField } from './noise.js';
import { TERRAIN_MAGNITUDE, TileMap, type TileMapParams, type TileRef } from './TileMap.js';

/**
 * Deterministic tile-map generation.
 *
 * Produces a byte-identical map on server and every client from a 32-bit seed,
 * which is what lets a 2-million-tile world cost four bytes on the wire instead
 * of the multi-megabyte binary a hand-authored map would require.
 *
 * The pipeline mirrors the Voronoi generator's — continental masks, fractal
 * detail, percentile-derived sea level — because those decisions were sound and
 * are independent of how territory is subdivided. What changes is that the
 * output is a raster rather than a set of polygons, and that ocean
 * connectivity and shorelines must be computed by flood fill rather than read
 * off an adjacency graph.
 */

export const DEFAULT_TILE_PARAMS: Omit<TileMapParams, 'seed'> = {
  /**
   * 1 024 × 512 ≈ 524 k tiles.
   *
   * Fine enough that borders read as organic curves rather than steps at
   * playable zoom, and small enough that generation stays well under a second
   * and the whole world fits in about 1.5 MB. Larger presets are available;
   * the generator is resolution-independent.
   */
  width: 1024,
  height: 512,
  landRatio: 0.32,
  continentCount: 4,
  islandDensity: 0.3,
  mountainRatio: 0.16,
};

export function createTileParams(
  seed: number,
  overrides: Partial<TileMapParams> = {},
): TileMapParams {
  const merged = { ...DEFAULT_TILE_PARAMS, ...overrides, seed };
  return {
    ...merged,
    width: Math.max(64, Math.floor(merged.width)),
    height: Math.max(64, Math.floor(merged.height)),
    landRatio: clamp(merged.landRatio, 0.05, 0.9),
    continentCount: Math.max(1, Math.floor(merged.continentCount)),
  };
}

export function generateTileMap(params: TileMapParams): TileMap {
  const rng = new Rng(params.seed);
  const width = params.width;
  const height = params.height;
  const tileCount = width * height;

  /* 1 — Elevation field ---------------------------------------------------- */
  const elevation = computeElevation(params, rng.fork('elevation'));

  /* 2 — Sea level from the distribution, not a constant --------------------- */
  // Noise distributions vary from seed to seed, so a fixed cutoff would give
  // wildly different land coverage per map and make `landRatio` a lie.
  const seaLevel = percentile(elevation, 1 - params.landRatio);

  const terrain = new Uint8Array(tileCount);
  const map = new TileMap(params, terrain);

  /* 3 — Land / water split and magnitude ----------------------------------- */
  const span = Math.max(1e-6, 1 - seaLevel);
  for (let ref = 0; ref < tileCount; ref++) {
    const value = elevation[ref] as number;
    if (value >= seaLevel) {
      // Normalise height above sea level into the 0-31 magnitude field, so
      // terrain bands do not depend on where sea level happened to land.
      const normalised = (value - seaLevel) / span;
      map.setLand(ref, Math.min(TERRAIN_MAGNITUDE, Math.round(normalised * 31)));
    } else {
      const depth = Math.min(TERRAIN_MAGNITUDE, Math.round((1 - value / seaLevel) * 31));
      map.setWater(ref, depth);
    }
  }

  /* 4 — Ocean connectivity -------------------------------------------------- */
  markOcean(map);

  /* 5 — Shorelines ---------------------------------------------------------- */
  markShorelines(map);

  map.recountLand();
  return map;
}

/**
 * Elevation field: continental masks plus fractal detail, faded at the borders.
 *
 * Pure fBm runs land off every edge of the map, which looks arbitrary and — more
 * importantly — leaves no open water for a naval game. Seeding a few continent
 * centres and applying a radial falloff produces recognisable landmasses
 * separated by navigable sea.
 */
function computeElevation(params: TileMapParams, rng: Rng): Float32Array {
  const { width, height } = params;
  const noise = new NoiseField(rng.fork('detail'));
  const warp = new NoiseField(rng.fork('warp'));

  const continentX = new Float32Array(params.continentCount);
  const continentY = new Float32Array(params.continentCount);
  const continentRadius = new Float32Array(params.continentCount);

  for (let c = 0; c < params.continentCount; c++) {
    // Keep centres off the border so continents are not clipped in half.
    continentX[c] = rng.nextRange(width * 0.18, width * 0.82);
    continentY[c] = rng.nextRange(height * 0.18, height * 0.82);
    continentRadius[c] = rng.nextRange(0.2, 0.42) * Math.min(width, height);
  }

  const elevation = new Float32Array(width * height);
  const detailScale = 3.5 / Math.max(width, height);
  const warpScale = 1.5 / Math.max(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ref = y * width + x;

      /**
       * Domain warping.
       *
       * Offsetting the sample position by another noise field before sampling
       * turns smooth circular coastlines into fjords, peninsulas and bays. It
       * is the cheapest single trick that stops a generated coast looking
       * generated, and it costs two extra noise samples per tile.
       */
      const warpX = warp.noise2D(x * warpScale, y * warpScale) * 60;
      const warpY = warp.noise2D(x * warpScale + 100, y * warpScale + 100) * 60;
      const sx = x + warpX;
      const sy = y + warpY;

      // Strongest continental influence wins, so overlapping continents merge
      // into one landmass rather than summing into an implausible plateau.
      let mask = 0;
      for (let c = 0; c < params.continentCount; c++) {
        const dx = sx - (continentX[c] as number);
        const dy = sy - (continentY[c] as number);
        const distance = Math.sqrt(dx * dx + dy * dy);
        const influence = 1 - distance / (continentRadius[c] as number);
        if (influence > mask) mask = influence;
      }
      mask = Math.max(0, Math.min(1, mask));
      // Smoothstep gives a continental shelf rather than a conical island.
      mask = mask * mask * (3 - 2 * mask);

      const detail = (noise.fbm(sx * detailScale, sy * detailScale, 6) + 1) * 0.5;

      // Border falloff, so the playable area is bounded by open ocean rather
      // than by an invisible wall at the edge of the raster.
      const edgeX = Math.min(x, width - 1 - x) / (width * 0.5);
      const edgeY = Math.min(y, height - 1 - y) / (height * 0.5);
      const edge = Math.min(1, Math.min(edgeX, edgeY) / 0.15);

      const islands = detail * 0.28 * (1 + params.islandDensity);
      elevation[ref] = (mask * 0.72 + islands) * edge;
    }
  }

  return elevation;
}

/**
 * Flood-fills sea inward from the map border.
 *
 * Water reachable from the edge is ocean; whatever remains is a lake. The
 * distinction is not cosmetic — the sea is one connected navigation graph, and
 * a fleet must not be able to sail through an inland lake to reach the far side
 * of a continent.
 *
 * Uses an explicit `Int32Array` queue rather than recursion: at half a million
 * tiles a recursive fill overflows the stack immediately.
 */
function markOcean(map: TileMap): void {
  const queue = new Int32Array(map.tileCount);
  let head = 0;
  let tail = 0;

  const enqueueIfWater = (ref: TileRef): void => {
    if (!map.isWater(ref) || map.isOcean(ref)) return;
    map.setOceanBit(ref);
    queue[tail++] = ref;
  };

  for (let x = 0; x < map.width; x++) {
    enqueueIfWater(map.ref(x, 0));
    enqueueIfWater(map.ref(x, map.height - 1));
  }
  for (let y = 0; y < map.height; y++) {
    enqueueIfWater(map.ref(0, y));
    enqueueIfWater(map.ref(map.width - 1, y));
  }

  while (head < tail) {
    const current = queue[head++] as number;
    map.forEachNeighbour(current, enqueueIfWater);
  }
}

/**
 * Marks tiles that sit on a land/water boundary.
 *
 * Both sides are flagged: coastal land is where ports go and where boats land,
 * and shore water is where they launch from. Diagonals count, so a diagonal
 * coastline is not full of gaps.
 */
function markShorelines(map: TileMap): void {
  for (let ref = 0; ref < map.tileCount; ref++) {
    const land = map.isLand(ref);
    let boundary = false;

    map.forEachNeighbourWithDiagonals(ref, (neighbour) => {
      if (boundary) return;
      if (map.isLand(neighbour) !== land) boundary = true;
    });

    if (boundary) map.setShorelineBit(ref);
  }
}

/** Value at a quantile of the elevation field. */
function percentile(values: Float32Array, quantile: number): number {
  const sorted = values.slice().sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)));
  return sorted[index] as number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
