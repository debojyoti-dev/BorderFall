/**
 * The tile world.
 *
 * A rectangular grid where every tile is individually owned. This replaces the
 * Voronoi region model, and the change is not cosmetic: per-tile ownership is
 * what produces borders that spread like ink rather than regions that blink
 * between colours. It is the single decision that defines how the game reads.
 *
 * ## Why a grid needs no adjacency structure
 *
 * The Voronoi model stored a CSR neighbour graph because cell adjacency was
 * irregular. On a grid, adjacency is arithmetic: `ref - width` is north,
 * `ref + 1` is east. That removes an entire data structure and makes neighbour
 * iteration a few integer adds — which matters enormously when conquest visits
 * millions of tiles.
 *
 * ## Why terrain is one packed byte
 *
 * At a few million tiles, every byte per tile is megabytes of memory and cache
 * pressure. Terrain type, shoreline, ocean-connectivity and elevation all fit
 * in one byte, so the whole terrain layer for a 2 048 × 1 024 map is 2 MB and
 * streams linearly.
 *
 * ## Coordinates
 *
 * A `TileRef` is simply `y * width + x`. It is a plain number rather than a
 * branded type because it is used in arithmetic constantly and the ceremony
 * would cost more than it catches. Bounds are checked at the edges of the API,
 * not on every access.
 */

export type TileRef = number;

/** No owner. Matches `OWNER_NONE` so the two layers agree. */
export const TILE_OWNER_NONE = 0xffff;

/* -------------------------------------------------------------------------- */
/* Terrain byte layout                                                         */
/* -------------------------------------------------------------------------- */

/**
 * ```
 * bit 7  land            1 = land, 0 = water
 * bit 6  shoreline       land touching water, or water touching land
 * bit 5  ocean           water reachable from the map border
 * bits 0-4  magnitude    elevation 0-31 (land) or depth (water)
 * ```
 *
 * Ocean-connectivity is stored rather than derived because ships need to know
 * that a lake is not the sea, and recomputing a flood fill per query would be
 * hopeless at this scale.
 */
export const TERRAIN_LAND = 0x80;
export const TERRAIN_SHORELINE = 0x40;
export const TERRAIN_OCEAN = 0x20;
export const TERRAIN_MAGNITUDE = 0x1f;

/** Elevation bands, derived from magnitude. Kept coarse so they read clearly. */
export const TileTerrain = {
  Ocean: 0,
  Lake: 1,
  Beach: 2,
  Plains: 3,
  Highland: 4,
  Mountain: 5,
} as const;

export type TileTerrain = (typeof TileTerrain)[keyof typeof TileTerrain];

/** Magnitude thresholds separating land bands. */
export const PLAINS_MAX_MAGNITUDE = 10;
export const HIGHLAND_MAX_MAGNITUDE = 20;

export interface TileMapParams {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  /** Fraction of tiles that should be land, 0–1. */
  readonly landRatio: number;
  readonly continentCount: number;
  readonly islandDensity: number;
  readonly mountainRatio: number;
}

export class TileMap {
  readonly width: number;
  readonly height: number;
  readonly tileCount: number;

  /** Packed terrain, one byte per tile. See the bit layout above. */
  readonly terrain: Uint8Array;

  /** Owning player slot per tile, or {@link TILE_OWNER_NONE}. */
  readonly owner: Uint16Array;

  /** Land tiles, counted once at generation for territory-share scoring. */
  private landTiles = 0;

  constructor(
    readonly params: TileMapParams,
    terrain?: Uint8Array,
  ) {
    this.width = params.width;
    this.height = params.height;
    this.tileCount = this.width * this.height;

    this.terrain = terrain ?? new Uint8Array(this.tileCount);
    this.owner = new Uint16Array(this.tileCount).fill(TILE_OWNER_NONE);

    if (terrain) this.recountLand();
  }

  /* Coordinates ----------------------------------------------------------- */

  ref(x: number, y: number): TileRef {
    return y * this.width + x;
  }

  x(ref: TileRef): number {
    return ref % this.width;
  }

  y(ref: TileRef): number {
    return (ref / this.width) | 0;
  }

  isValidRef(ref: TileRef): boolean {
    return ref >= 0 && ref < this.tileCount;
  }

  isValidCoord(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /* Terrain queries -------------------------------------------------------- */

  isLand(ref: TileRef): boolean {
    return ((this.terrain[ref] as number) & TERRAIN_LAND) !== 0;
  }

  isWater(ref: TileRef): boolean {
    return ((this.terrain[ref] as number) & TERRAIN_LAND) === 0;
  }

  /** Water connected to the map border — navigable sea, as opposed to a lake. */
  isOcean(ref: TileRef): boolean {
    return ((this.terrain[ref] as number) & TERRAIN_OCEAN) !== 0;
  }

  isLake(ref: TileRef): boolean {
    const byte = this.terrain[ref] as number;
    return (byte & TERRAIN_LAND) === 0 && (byte & TERRAIN_OCEAN) === 0;
  }

  isShoreline(ref: TileRef): boolean {
    return ((this.terrain[ref] as number) & TERRAIN_SHORELINE) !== 0;
  }

  /** Land adjacent to water: where ports may be built and boats may land. */
  isCoast(ref: TileRef): boolean {
    const byte = this.terrain[ref] as number;
    return (byte & TERRAIN_LAND) !== 0 && (byte & TERRAIN_SHORELINE) !== 0;
  }

  magnitude(ref: TileRef): number {
    return (this.terrain[ref] as number) & TERRAIN_MAGNITUDE;
  }

  terrainType(ref: TileRef): TileTerrain {
    const byte = this.terrain[ref] as number;
    if ((byte & TERRAIN_LAND) === 0) {
      return (byte & TERRAIN_OCEAN) !== 0 ? TileTerrain.Ocean : TileTerrain.Lake;
    }
    const magnitude = byte & TERRAIN_MAGNITUDE;
    if ((byte & TERRAIN_SHORELINE) !== 0) return TileTerrain.Beach;
    if (magnitude <= PLAINS_MAX_MAGNITUDE) return TileTerrain.Plains;
    if (magnitude <= HIGHLAND_MAX_MAGNITUDE) return TileTerrain.Highland;
    return TileTerrain.Mountain;
  }

  /**
   * Movement and conquest cost multiplier for the terrain.
   *
   * Mountains cost double, so a range genuinely slows an advance and becomes a
   * natural border rather than decoration.
   */
  terrainCost(ref: TileRef): number {
    switch (this.terrainType(ref)) {
      case TileTerrain.Mountain:
        return 2;
      case TileTerrain.Highland:
        return 1.5;
      default:
        return 1;
    }
  }

  /* Terrain mutation, used only during generation --------------------------- */

  setLand(ref: TileRef, magnitude: number): void {
    this.terrain[ref] = TERRAIN_LAND | (magnitude & TERRAIN_MAGNITUDE);
  }

  setWater(ref: TileRef, magnitude: number): void {
    this.terrain[ref] = magnitude & TERRAIN_MAGNITUDE;
  }

  setOceanBit(ref: TileRef): void {
    this.terrain[ref] = (this.terrain[ref] as number) | TERRAIN_OCEAN;
  }

  setShorelineBit(ref: TileRef): void {
    this.terrain[ref] = (this.terrain[ref] as number) | TERRAIN_SHORELINE;
  }

  /* Ownership -------------------------------------------------------------- */

  ownerOf(ref: TileRef): number {
    return this.owner[ref] as number;
  }

  hasOwner(ref: TileRef): boolean {
    return this.owner[ref] !== TILE_OWNER_NONE;
  }

  setOwner(ref: TileRef, slot: number): void {
    this.owner[ref] = slot;
  }

  /**
   * True when the tile borders a tile with a different owner, or water.
   *
   * Border tiles are the only ones conquest ever examines, so this test runs
   * constantly and is written to avoid any allocation.
   */
  isBorder(ref: TileRef): boolean {
    const mine = this.owner[ref] as number;
    const x = ref % this.width;

    if (ref >= this.width && this.owner[ref - this.width] !== mine) return true;
    if (ref < this.tileCount - this.width && this.owner[ref + this.width] !== mine) return true;
    if (x > 0 && this.owner[ref - 1] !== mine) return true;
    if (x < this.width - 1 && this.owner[ref + 1] !== mine) return true;
    return false;
  }

  /* Neighbours ------------------------------------------------------------- */

  /**
   * Visits the four cardinal neighbours, skipping those off the map.
   *
   * Order is always north, south, west, east. Fixed ordering matters for
   * determinism: conquest enqueues neighbours in this order, and a different
   * order would produce a different — though equally valid — battle outcome,
   * which would desync a lockstep match.
   */
  forEachNeighbour(ref: TileRef, visit: (neighbour: TileRef) => void): void {
    const x = ref % this.width;
    if (ref >= this.width) visit(ref - this.width);
    if (ref < this.tileCount - this.width) visit(ref + this.width);
    if (x > 0) visit(ref - 1);
    if (x < this.width - 1) visit(ref + 1);
  }

  /**
   * Writes cardinal neighbours into `out` and returns how many there are.
   *
   * The allocation-free form, for the conquest inner loop. `out` must have
   * length ≥ 4 and is reused across calls.
   */
  neighbours4(ref: TileRef, out: Int32Array | number[]): number {
    const x = ref % this.width;
    let count = 0;
    if (ref >= this.width) out[count++] = ref - this.width;
    if (ref < this.tileCount - this.width) out[count++] = ref + this.width;
    if (x > 0) out[count++] = ref - 1;
    if (x < this.width - 1) out[count++] = ref + 1;
    return count;
  }

  /** Includes diagonals. Used for shoreline detection and blast radii. */
  forEachNeighbourWithDiagonals(ref: TileRef, visit: (neighbour: TileRef) => void): void {
    const x = ref % this.width;
    const y = (ref / this.width) | 0;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= this.height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= this.width) continue;
        visit(ny * this.width + nx);
      }
    }
  }

  /** How many cardinal neighbours belong to `slot`. Drives conquest priority. */
  neighboursOwnedBy(ref: TileRef, slot: number): number {
    const x = ref % this.width;
    let count = 0;
    if (ref >= this.width && this.owner[ref - this.width] === slot) count++;
    if (ref < this.tileCount - this.width && this.owner[ref + this.width] === slot) count++;
    if (x > 0 && this.owner[ref - 1] === slot) count++;
    if (x < this.width - 1 && this.owner[ref + 1] === slot) count++;
    return count;
  }

  /* Aggregates ------------------------------------------------------------- */

  get numLandTiles(): number {
    return this.landTiles;
  }

  recountLand(): void {
    let total = 0;
    for (let ref = 0; ref < this.tileCount; ref++) {
      // Parenthesise the assertion. `x as number & TERRAIN_LAND` parses as a
      // type assertion to the intersection `number & 128`, not as a bitwise
      // and — so it silently became a "byte is non-zero" test and counted
      // every ocean tile with a depth value as land.
      if (((this.terrain[ref] as number) & TERRAIN_LAND) !== 0) total++;
    }
    this.landTiles = total;
  }

  /** Chebyshev distance, the natural metric on a grid with diagonal movement. */
  chebyshevDistance(a: TileRef, b: TileRef): number {
    const dx = Math.abs((a % this.width) - (b % this.width));
    const dy = Math.abs(((a / this.width) | 0) - ((b / this.width) | 0));
    return Math.max(dx, dy);
  }

  manhattanDistance(a: TileRef, b: TileRef): number {
    const dx = Math.abs((a % this.width) - (b % this.width));
    const dy = Math.abs(((a / this.width) | 0) - ((b / this.width) | 0));
    return dx + dy;
  }

  euclideanDistance(a: TileRef, b: TileRef): number {
    const dx = (a % this.width) - (b % this.width);
    const dy = ((a / this.width) | 0) - ((b / this.width) | 0);
    return Math.sqrt(dx * dx + dy * dy);
  }
}
