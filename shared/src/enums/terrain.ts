/**
 * Terrain classification for a territory.
 *
 * Encoded as a `Uint8` on the wire and in the server's structure-of-arrays world
 * store. Values are frozen: they are part of the replay format, so inserting a
 * new member in the middle would invalidate every stored replay. Always append.
 */
export const Terrain = {
  /** Deep water. Impassable to land units, navigable by ships. */
  Ocean: 0,
  /** Shallow water adjacent to land. Ports may be built on adjacent land. */
  Coast: 1,
  /** Inland water body. Navigable but not connected to the ocean graph. */
  Lake: 2,
  /** Baseline land. No modifiers. */
  Plains: 3,
  /** Modest defensive bonus, reduced income. */
  Forest: 4,
  /** Strong defensive bonus, slow troop movement. */
  Hills: 5,
  /** Highest defensive bonus, minimal population growth. */
  Mountain: 6,
  /** Low population cap, high steel yield (reserved for the resource phase). */
  Desert: 7,
  /** Low population growth, low income. */
  Tundra: 8,
} as const;

export type Terrain = (typeof Terrain)[keyof typeof Terrain];

/** Terrain values that a ship may occupy. */
export const NAVIGABLE_TERRAIN: readonly Terrain[] = [Terrain.Ocean, Terrain.Coast, Terrain.Lake];

/** Terrain values that a land army may occupy. */
export const LAND_TERRAIN: readonly Terrain[] = [
  Terrain.Plains,
  Terrain.Forest,
  Terrain.Hills,
  Terrain.Mountain,
  Terrain.Desert,
  Terrain.Tundra,
];

export function isWater(terrain: Terrain): boolean {
  return terrain === Terrain.Ocean || terrain === Terrain.Coast || terrain === Terrain.Lake;
}

export function isLand(terrain: Terrain): boolean {
  return !isWater(terrain);
}

/** Ocean-connected water, i.e. reachable by sea-going vessels. */
export function isSea(terrain: Terrain): boolean {
  return terrain === Terrain.Ocean || terrain === Terrain.Coast;
}
