import { describe, expect, it } from 'vitest';
import { Terrain, isLand, isWater } from '../enums/terrain.js';
import { createMapParams, generateWorld } from './generator.js';
import { WorldReader } from './WorldReader.js';

/** Small worlds keep the suite fast; the algorithms are size-independent. */
const SMALL = { territoryCount: 400, width: 2048, height: 2048 };

function world(seed: number, overrides = {}) {
  return generateWorld(createMapParams(seed, { ...SMALL, ...overrides }));
}

describe('generateWorld — determinism', () => {
  it('produces a byte-identical world for the same seed', () => {
    const a = world(12345);
    const b = world(12345);

    // This is the property the entire 4-bytes-instead-of-2MB replication
    // scheme depends on. If it ever fails, clients desync from the server's
    // map and every stored replay becomes unreplayable.
    expect(a.territoryCount).toBe(b.territoryCount);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(Array.from(a.centroidX)).toEqual(Array.from(b.centroidX));
    expect(Array.from(a.centroidY)).toEqual(Array.from(b.centroidY));
    expect(Array.from(a.polygonPoints)).toEqual(Array.from(b.polygonPoints));
    expect(Array.from(a.polygonOffsets)).toEqual(Array.from(b.polygonOffsets));
    expect(Array.from(a.neighbours)).toEqual(Array.from(b.neighbours));
    expect(Array.from(a.neighbourOffsets)).toEqual(Array.from(b.neighbourOffsets));
    expect(Array.from(a.spawnCandidates)).toEqual(Array.from(b.spawnCandidates));
  });

  it('produces a different world for a different seed', () => {
    const a = world(1);
    const b = world(2);
    expect(Array.from(a.terrain)).not.toEqual(Array.from(b.terrain));
  });

  it('does not depend on generation order or shared mutable state', () => {
    // Generating an unrelated world in between must not perturb the result —
    // it would mean some module-level state is leaking across matches.
    const first = world(777);
    world(999);
    const second = world(777);
    expect(Array.from(second.terrain)).toEqual(Array.from(first.terrain));
    expect(Array.from(second.centroidX)).toEqual(Array.from(first.centroidX));
  });
});

describe('generateWorld — topology', () => {
  it('generates approximately the requested territory count', () => {
    const geometry = world(42, { territoryCount: 400 });
    // Poisson sampling cannot hit an exact count; ±25 % is the useful contract.
    expect(geometry.territoryCount).toBeGreaterThan(300);
    expect(geometry.territoryCount).toBeLessThan(500);
  });

  it('scales to a full-size world', () => {
    const geometry = generateWorld(createMapParams(7, { territoryCount: 5000 }));
    expect(geometry.territoryCount).toBeGreaterThan(4000);
    expect(geometry.territoryCount).toBeLessThan(6500);
  });

  it('gives every territory a valid CSR polygon', () => {
    const geometry = world(3);
    expect(geometry.polygonOffsets.length).toBe(geometry.territoryCount + 1);
    expect(geometry.polygonOffsets[0]).toBe(0);
    expect(geometry.polygonOffsets[geometry.territoryCount]).toBe(geometry.polygonPoints.length);

    for (let i = 0; i < geometry.territoryCount; i++) {
      const start = geometry.polygonOffsets[i]!;
      const end = geometry.polygonOffsets[i + 1]!;
      expect(end).toBeGreaterThanOrEqual(start);
      // Offsets index a flat [x, y, ...] array, so spans must be even.
      expect((end - start) % 2).toBe(0);
      // A real cell is at least a triangle.
      expect((end - start) / 2).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps every vertex inside the world bounds', () => {
    const geometry = world(11);
    for (let k = 0; k < geometry.polygonPoints.length; k += 2) {
      expect(geometry.polygonPoints[k]).toBeGreaterThanOrEqual(-0.01);
      expect(geometry.polygonPoints[k]).toBeLessThanOrEqual(geometry.params.width + 0.01);
      expect(geometry.polygonPoints[k + 1]).toBeGreaterThanOrEqual(-0.01);
      expect(geometry.polygonPoints[k + 1]).toBeLessThanOrEqual(geometry.params.height + 0.01);
    }
  });

  it('produces a symmetric neighbour graph', () => {
    // Asymmetry would let A attack B while B cannot retaliate — a real
    // gameplay exploit, not just a data-quality nit.
    const geometry = world(5);
    const reader = new WorldReader(geometry);

    for (let i = 0; i < geometry.territoryCount; i++) {
      reader.forEachNeighbour(i, (neighbour) => {
        expect(reader.areNeighbours(neighbour, i)).toBe(true);
      });
    }
  });

  it('never lists a territory as its own neighbour', () => {
    const geometry = world(8);
    const reader = new WorldReader(geometry);
    for (let i = 0; i < geometry.territoryCount; i++) {
      reader.forEachNeighbour(i, (neighbour) => {
        expect(neighbour).not.toBe(i);
      });
    }
  });

  it('lists no duplicate neighbours', () => {
    const geometry = world(9);
    const reader = new WorldReader(geometry);
    for (let i = 0; i < geometry.territoryCount; i++) {
      const seen = new Set<number>();
      reader.forEachNeighbour(i, (neighbour) => {
        expect(seen.has(neighbour)).toBe(false);
        seen.add(neighbour);
      });
    }
  });

  it('connects every territory to at least one neighbour', () => {
    const geometry = world(13);
    const reader = new WorldReader(geometry);
    for (let i = 0; i < geometry.territoryCount; i++) {
      expect(reader.getNeighbourCount(i)).toBeGreaterThan(0);
    }
  });

  it('keeps neighbour degree within plausible Voronoi bounds', () => {
    const geometry = world(21);
    const reader = new WorldReader(geometry);
    let total = 0;
    for (let i = 0; i < geometry.territoryCount; i++) {
      const degree = reader.getNeighbourCount(i);
      expect(degree).toBeLessThanOrEqual(24);
      total += degree;
    }
    // A planar Voronoi diagram averages ~6 neighbours per cell (Euler's
    // formula). Straying far from that means the bisector search is missing
    // real borders or inventing false ones.
    const mean = total / geometry.territoryCount;
    expect(mean).toBeGreaterThan(4);
    expect(mean).toBeLessThan(8);
  });

  it('places centroids inside their own bounding box', () => {
    const geometry = world(17);
    const reader = new WorldReader(geometry);
    for (let i = 0; i < geometry.territoryCount; i++) {
      const [minX, minY, maxX, maxY] = reader.getBounds(i);
      expect(reader.getCentroidX(i)).toBeGreaterThanOrEqual(minX - 0.01);
      expect(reader.getCentroidX(i)).toBeLessThanOrEqual(maxX + 0.01);
      expect(reader.getCentroidY(i)).toBeGreaterThanOrEqual(minY - 0.01);
      expect(reader.getCentroidY(i)).toBeLessThanOrEqual(maxY + 0.01);
    }
  });

  it('gives every territory positive area', () => {
    const geometry = world(19);
    for (let i = 0; i < geometry.territoryCount; i++) {
      expect(geometry.area[i]).toBeGreaterThan(0);
    }
  });

  it('has total cell area approximating the world area', () => {
    // Voronoi cells tile the bounding box exactly, so the sum is a strong
    // end-to-end check that no cell was lost or double-counted.
    const geometry = world(23);
    let total = 0;
    for (let i = 0; i < geometry.territoryCount; i++) total += geometry.area[i]!;
    const expected = geometry.params.width * geometry.params.height;
    expect(total / expected).toBeGreaterThan(0.97);
    expect(total / expected).toBeLessThan(1.03);
  });
});

describe('generateWorld — terrain', () => {
  it('respects the requested land ratio', () => {
    for (const landRatio of [0.25, 0.42, 0.6]) {
      const geometry = world(31, { landRatio });
      let land = 0;
      for (let i = 0; i < geometry.territoryCount; i++) {
        if (isLand(geometry.terrain[i] as Terrain)) land++;
      }
      const actual = land / geometry.territoryCount;
      // Coast reclassification and border falloff shift this a little, so the
      // tolerance is generous — but it must track the parameter.
      expect(actual).toBeGreaterThan(landRatio - 0.18);
      expect(actual).toBeLessThan(landRatio + 0.18);
    }
  });

  it('surrounds the map border with water', () => {
    // The playable area must be bounded by ocean rather than by an invisible
    // wall at the edge of the world rectangle.
    const geometry = world(37);
    const reader = new WorldReader(geometry);
    const margin = Math.min(geometry.params.width, geometry.params.height) * 0.02;

    let checked = 0;
    for (let i = 0; i < geometry.territoryCount; i++) {
      const x = reader.getCentroidX(i);
      const y = reader.getCentroidY(i);
      const onBorder =
        x < margin ||
        y < margin ||
        x > geometry.params.width - margin ||
        y > geometry.params.height - margin;
      if (!onBorder) continue;
      checked++;
      expect(isWater(geometry.terrain[i] as Terrain)).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('emits only known terrain values', () => {
    const geometry = world(41);
    const valid = new Set<number>(Object.values(Terrain));
    for (let i = 0; i < geometry.territoryCount; i++) {
      expect(valid.has(geometry.terrain[i]!)).toBe(true);
    }
  });

  it('marks coast only on water bordering land', () => {
    const geometry = world(43);
    const reader = new WorldReader(geometry);

    for (let i = 0; i < geometry.territoryCount; i++) {
      if (geometry.terrain[i] !== Terrain.Coast) continue;
      let touchesLand = false;
      reader.forEachNeighbour(i, (neighbour) => {
        if (isLand(geometry.terrain[neighbour] as Terrain)) touchesLand = true;
      });
      expect(touchesLand).toBe(true);
    }
  });

  it('never places a lake adjacent to open ocean', () => {
    // A lake touching the sea would be reachable by fleets, defeating the
    // whole point of separating inland water from the navigation graph.
    const geometry = world(47);
    const reader = new WorldReader(geometry);

    for (let i = 0; i < geometry.territoryCount; i++) {
      if (geometry.terrain[i] !== Terrain.Lake) continue;
      reader.forEachNeighbour(i, (neighbour) => {
        const neighbourTerrain = geometry.terrain[neighbour] as Terrain;
        expect(neighbourTerrain === Terrain.Ocean || neighbourTerrain === Terrain.Coast).toBe(
          false,
        );
      });
    }
  });

  it('produces meaningful relief on every seed', () => {
    // Regression guard. Absolute thresholds against a noise field that
    // concentrates near its midpoint yielded 0 % mountains and 0.1 % desert —
    // a map of undifferentiated plains with no strategic terrain. Thresholds
    // are now derived from the distribution, which must hold for any seed.
    for (const seed of [2026, 7, 999, 12345]) {
      const geometry = world(seed);
      const counts = new Map<number, number>();
      for (let i = 0; i < geometry.territoryCount; i++) {
        counts.set(geometry.terrain[i]!, (counts.get(geometry.terrain[i]!) ?? 0) + 1);
      }

      let land = 0;
      for (let i = 0; i < geometry.territoryCount; i++) {
        if (isLand(geometry.terrain[i] as Terrain)) land++;
      }

      const mountains = counts.get(Terrain.Mountain) ?? 0;
      const hills = counts.get(Terrain.Hills) ?? 0;
      const relief = (mountains + hills) / land;

      expect(mountains).toBeGreaterThan(0);
      expect(hills).toBeGreaterThan(0);
      // mountainRatio defaults to 0.18 of land.
      expect(relief).toBeGreaterThan(0.1);
      expect(relief).toBeLessThan(0.3);
    }
  });

  it('produces every land biome at default settings', () => {
    const geometry = world(2026);
    const present = new Set<number>();
    for (let i = 0; i < geometry.territoryCount; i++) present.add(geometry.terrain[i]!);

    for (const biome of [
      Terrain.Plains,
      Terrain.Forest,
      Terrain.Hills,
      Terrain.Mountain,
      Terrain.Desert,
    ]) {
      expect(present.has(biome)).toBe(true);
    }
  });

  it('produces some land and some water at default settings', () => {
    const geometry = world(53);
    let land = 0;
    let water = 0;
    for (let i = 0; i < geometry.territoryCount; i++) {
      if (isLand(geometry.terrain[i] as Terrain)) land++;
      else water++;
    }
    expect(land).toBeGreaterThan(0);
    expect(water).toBeGreaterThan(0);
  });
});

describe('generateWorld — spawns', () => {
  it('places every spawn candidate on land', () => {
    const geometry = world(59);
    expect(geometry.spawnCandidates.length).toBeGreaterThan(0);
    for (const id of geometry.spawnCandidates) {
      expect(isLand(geometry.terrain[id] as Terrain)).toBe(true);
    }
  });

  it('emits unique, in-range spawn ids', () => {
    const geometry = world(61);
    const seen = new Set<number>();
    for (const id of geometry.spawnCandidates) {
      expect(id).toBeLessThan(geometry.territoryCount);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('spreads the first spawns far apart', () => {
    // Greedy farthest-point selection should put early picks near opposite
    // ends of the map, so the first players to be seated are not neighbours.
    const geometry = world(67);
    const reader = new WorldReader(geometry);
    const [first, second] = [geometry.spawnCandidates[0]!, geometry.spawnCandidates[1]!];

    const dx = reader.getCentroidX(first) - reader.getCentroidX(second);
    const dy = reader.getCentroidY(first) - reader.getCentroidY(second);
    const distance = Math.hypot(dx, dy);

    expect(distance).toBeGreaterThan(geometry.params.width * 0.25);
  });
});

describe('createMapParams', () => {
  it('clamps out-of-range inputs instead of trusting them', () => {
    const params = createMapParams(1, {
      territoryCount: 4,
      landRatio: 5,
      continentCount: -3,
      relaxationPasses: 99,
    });
    expect(params.territoryCount).toBeGreaterThanOrEqual(256);
    expect(params.landRatio).toBeLessThanOrEqual(0.9);
    expect(params.continentCount).toBeGreaterThanOrEqual(1);
    expect(params.relaxationPasses).toBeLessThanOrEqual(6);
  });

  it('preserves the seed exactly', () => {
    expect(createMapParams(0xdeadbeef).seed).toBe(0xdeadbeef);
  });
});
