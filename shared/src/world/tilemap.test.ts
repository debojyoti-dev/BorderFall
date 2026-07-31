import { describe, expect, it } from 'vitest';
import { TILE_OWNER_NONE, TileTerrain } from './TileMap.js';
import { createTileParams, generateTileMap } from './tilegen.js';

/** Small maps keep the suite fast; the algorithms are resolution-independent. */
const SMALL = { width: 256, height: 128 };

function makeMap(seed = 1, overrides = {}) {
  return generateTileMap(createTileParams(seed, { ...SMALL, ...overrides }));
}

describe('TileMap geometry', () => {
  const map = makeMap();

  it('round-trips coordinates and refs', () => {
    for (const [x, y] of [
      [0, 0],
      [5, 9],
      [map.width - 1, map.height - 1],
    ] as const) {
      const ref = map.ref(x, y);
      expect(map.x(ref)).toBe(x);
      expect(map.y(ref)).toBe(y);
    }
  });

  it('validates refs and coordinates', () => {
    expect(map.isValidRef(0)).toBe(true);
    expect(map.isValidRef(map.tileCount - 1)).toBe(true);
    expect(map.isValidRef(map.tileCount)).toBe(false);
    expect(map.isValidRef(-1)).toBe(false);
    expect(map.isValidCoord(-1, 0)).toBe(false);
    expect(map.isValidCoord(map.width, 0)).toBe(false);
  });

  it('gives interior tiles four neighbours and corners two', () => {
    const interior: number[] = [];
    map.forEachNeighbour(map.ref(10, 10), (n) => interior.push(n));
    expect(interior).toHaveLength(4);

    const corner: number[] = [];
    map.forEachNeighbour(map.ref(0, 0), (n) => corner.push(n));
    expect(corner).toHaveLength(2);

    const edge: number[] = [];
    map.forEachNeighbour(map.ref(0, 5), (n) => edge.push(n));
    expect(edge).toHaveLength(3);
  });

  it('never wraps neighbours around a row', () => {
    // The classic grid bug: ref-1 at x=0 lands on the previous row's last tile,
    // which would let armies teleport across the map.
    const leftEdge = map.ref(0, 7);
    const found: number[] = [];
    map.forEachNeighbour(leftEdge, (n) => found.push(n));
    expect(found).not.toContain(leftEdge - 1);

    const rightEdge = map.ref(map.width - 1, 7);
    const rightFound: number[] = [];
    map.forEachNeighbour(rightEdge, (n) => rightFound.push(n));
    expect(rightFound).not.toContain(rightEdge + 1);
  });

  it('agrees between forEachNeighbour and neighbours4', () => {
    const out = new Int32Array(4);
    for (const ref of [map.ref(0, 0), map.ref(10, 10), map.ref(map.width - 1, map.height - 1)]) {
      const visited: number[] = [];
      map.forEachNeighbour(ref, (n) => visited.push(n));
      const count = map.neighbours4(ref, out);
      expect(count).toBe(visited.length);
      expect(Array.from(out.subarray(0, count))).toEqual(visited);
    }
  });

  it('gives interior tiles eight diagonal neighbours', () => {
    const found: number[] = [];
    map.forEachNeighbourWithDiagonals(map.ref(20, 20), (n) => found.push(n));
    expect(found).toHaveLength(8);
    expect(new Set(found).size).toBe(8);
  });

  it('measures distance on the grid', () => {
    const a = map.ref(2, 2);
    const b = map.ref(5, 6);
    expect(map.manhattanDistance(a, b)).toBe(7);
    expect(map.chebyshevDistance(a, b)).toBe(4);
    expect(map.euclideanDistance(a, b)).toBeCloseTo(5, 6);
  });
});

describe('TileMap ownership', () => {
  it('starts unowned', () => {
    const map = makeMap();
    expect(map.ownerOf(0)).toBe(TILE_OWNER_NONE);
    expect(map.hasOwner(0)).toBe(false);
  });

  it('detects borders against a different owner', () => {
    const map = makeMap();
    const centre = map.ref(10, 10);

    map.setOwner(centre, 1);
    // Surrounded by unowned tiles, so it is a border.
    expect(map.isBorder(centre)).toBe(true);

    map.forEachNeighbour(centre, (n) => map.setOwner(n, 1));
    expect(map.isBorder(centre)).toBe(false);
  });

  it('counts neighbours owned by a slot', () => {
    const map = makeMap();
    const centre = map.ref(20, 20);
    expect(map.neighboursOwnedBy(centre, 3)).toBe(0);

    let assigned = 0;
    map.forEachNeighbour(centre, (n) => {
      if (assigned < 2) {
        map.setOwner(n, 3);
        assigned++;
      }
    });
    expect(map.neighboursOwnedBy(centre, 3)).toBe(2);
  });
});

describe('tile generation', () => {
  it('is deterministic for a seed', () => {
    const a = makeMap(4242);
    const b = makeMap(4242);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
  });

  it('differs between seeds', () => {
    expect(Array.from(makeMap(1).terrain)).not.toEqual(Array.from(makeMap(2).terrain));
  });

  it('respects the requested land ratio', () => {
    for (const landRatio of [0.2, 0.32, 0.5]) {
      const map = makeMap(7, { landRatio });
      const actual = map.numLandTiles / map.tileCount;
      expect(actual).toBeGreaterThan(landRatio - 0.05);
      expect(actual).toBeLessThan(landRatio + 0.05);
    }
  });

  it('counts land correctly rather than counting non-zero bytes', () => {
    // Regression guard. `x as number & TERRAIN_LAND` parses as a type
    // assertion, not a bitwise and, which silently made this a "byte is
    // non-zero" test and reported 100 % land on every map.
    const map = makeMap(11);
    let manual = 0;
    for (let ref = 0; ref < map.tileCount; ref++) {
      if (map.isLand(ref)) manual++;
    }
    expect(map.numLandTiles).toBe(manual);
    expect(map.numLandTiles).toBeLessThan(map.tileCount);
    expect(map.numLandTiles).toBeGreaterThan(0);
  });

  it('surrounds the map border with water', () => {
    // The playable area must be bounded by ocean, not by an invisible wall.
    const map = makeMap(13);
    for (let x = 0; x < map.width; x++) {
      expect(map.isWater(map.ref(x, 0))).toBe(true);
      expect(map.isWater(map.ref(x, map.height - 1))).toBe(true);
    }
    for (let y = 0; y < map.height; y++) {
      expect(map.isWater(map.ref(0, y))).toBe(true);
      expect(map.isWater(map.ref(map.width - 1, y))).toBe(true);
    }
  });

  it('marks border water as ocean', () => {
    const map = makeMap(17);
    expect(map.isOcean(map.ref(0, 0))).toBe(true);
    expect(map.isLake(map.ref(0, 0))).toBe(false);
  });

  it('never marks land as ocean or lake', () => {
    const map = makeMap(19);
    for (let ref = 0; ref < map.tileCount; ref++) {
      if (!map.isLand(ref)) continue;
      expect(map.isOcean(ref)).toBe(false);
      expect(map.isLake(ref)).toBe(false);
    }
  });

  it('classifies every tile into a known terrain band', () => {
    const map = makeMap(23);
    const valid = new Set<number>(Object.values(TileTerrain));
    for (let ref = 0; ref < map.tileCount; ref++) {
      expect(valid.has(map.terrainType(ref))).toBe(true);
    }
  });

  it('marks shoreline on both sides of a coast', () => {
    const map = makeMap(29);
    let coastalLand = 0;
    let shoreWater = 0;

    for (let ref = 0; ref < map.tileCount; ref++) {
      if (!map.isShoreline(ref)) continue;
      if (map.isLand(ref)) coastalLand++;
      else shoreWater++;

      // A shoreline tile must actually touch the opposite element.
      let touchesOpposite = false;
      const land = map.isLand(ref);
      map.forEachNeighbourWithDiagonals(ref, (n) => {
        if (map.isLand(n) !== land) touchesOpposite = true;
      });
      expect(touchesOpposite).toBe(true);
    }

    expect(coastalLand).toBeGreaterThan(0);
    expect(shoreWater).toBeGreaterThan(0);
  });

  it('produces mountains, highland and plains', () => {
    const map = makeMap(31);
    const counts = new Map<number, number>();
    for (let ref = 0; ref < map.tileCount; ref++) {
      counts.set(map.terrainType(ref), (counts.get(map.terrainType(ref)) ?? 0) + 1);
    }
    expect(counts.get(TileTerrain.Plains) ?? 0).toBeGreaterThan(0);
    expect(counts.get(TileTerrain.Highland) ?? 0).toBeGreaterThan(0);
    expect(counts.get(TileTerrain.Mountain) ?? 0).toBeGreaterThan(0);
  });

  it('charges more to cross high ground', () => {
    const map = makeMap(37);
    let mountain = -1;
    let plains = -1;
    for (let ref = 0; ref < map.tileCount && (mountain < 0 || plains < 0); ref++) {
      if (mountain < 0 && map.terrainType(ref) === TileTerrain.Mountain) mountain = ref;
      if (plains < 0 && map.terrainType(ref) === TileTerrain.Plains) plains = ref;
    }
    expect(map.terrainCost(mountain)).toBeGreaterThan(map.terrainCost(plains));
  });

  it('generates a playable map within a reasonable budget', () => {
    const started = performance.now();
    generateTileMap(createTileParams(41, { width: 1024, height: 512 }));
    const elapsed = performance.now() - started;

    // Runs on every client at join, so it must not stall the page. Generous —
    // this guards against an accidental O(n²), not against a few percent.
    expect(elapsed).toBeLessThan(2000);
  });
});
