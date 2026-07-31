import { describe, expect, it } from 'vitest';
import { Rng } from '../utils/prng.js';
import { Attack, CONQUEST } from './Conquest.js';
import { TILE_OWNER_NONE, TileMap, type TileMapParams } from './TileMap.js';
import { TileHeap } from './TileHeap.js';
import { TileWorld } from './TileWorld.js';

/**
 * A flat all-land map, so conquest behaviour is tested without terrain noise
 * confounding the result. Terrain effects get their own test.
 */
function flatWorld(width = 64, height = 64): TileWorld {
  const params: TileMapParams = {
    seed: 1,
    width,
    height,
    landRatio: 1,
    continentCount: 1,
    islandDensity: 0,
    mountainRatio: 0,
  };
  const map = new TileMap(params);
  for (let ref = 0; ref < map.tileCount; ref++) map.setLand(ref, 0);
  map.recountLand();
  return new TileWorld(map);
}

/** Fills a rectangle with an owner. */
function claim(world: TileWorld, slot: number, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) world.setOwner(world.map.ref(x, y), slot);
  }
}

describe('TileHeap', () => {
  it('yields refs in ascending priority', () => {
    const heap = new TileHeap(4);
    for (const [ref, priority] of [
      [10, 5],
      [20, 1],
      [30, 9],
      [40, 3],
    ] as const) {
      heap.push(ref, priority);
    }

    expect([heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual([20, 40, 10, 30]);
    expect(heap.pop()).toBe(-1);
  });

  it('grows past its initial capacity', () => {
    const heap = new TileHeap(2);
    for (let i = 0; i < 500; i++) heap.push(i, 500 - i);
    expect(heap.length).toBe(500);
    expect(heap.pop()).toBe(499);
  });

  it('reports emptiness and peeks without removing', () => {
    const heap = new TileHeap();
    expect(heap.isEmpty).toBe(true);
    expect(heap.peek()).toBe(-1);

    heap.push(7, 1);
    expect(heap.peek()).toBe(7);
    expect(heap.length).toBe(1);
  });
});

describe('TileWorld border tracking', () => {
  it('tracks tile counts and frontier as ownership changes', () => {
    const world = flatWorld(16, 16);
    world.addPlayer(0, 1000, 0);

    claim(world, 0, 4, 4, 6, 6);
    const state = world.player(0)!;

    expect(state.tilesOwned).toBe(9);
    // The 3x3 block's centre is interior; the other eight are frontier.
    expect(state.borderTiles.size).toBe(8);
    expect(state.borderTiles.has(world.map.ref(5, 5))).toBe(false);
  });

  it('updates a neighbour’s frontier when a tile changes hands', () => {
    const world = flatWorld(16, 16);
    world.addPlayer(0, 1000, 0);
    world.addPlayer(1, 1000, 0);

    claim(world, 0, 4, 4, 6, 6);
    // Taking the centre away must return the surrounding tiles to frontier.
    world.setOwner(world.map.ref(5, 5), 1);

    expect(world.player(0)!.tilesOwned).toBe(8);
    expect(world.player(1)!.tilesOwned).toBe(1);
    expect(world.player(0)!.borderTiles.size).toBe(8);
  });

  it('finds the frontier against a specific opponent', () => {
    const world = flatWorld(16, 16);
    world.addPlayer(0, 1000, 0);
    world.addPlayer(1, 1000, 0);

    claim(world, 0, 0, 0, 3, 15);
    claim(world, 1, 4, 0, 7, 15);

    const frontier = world.frontierAgainst(0, 1, []);
    // The whole x=3 column touches player 1.
    expect(frontier).toHaveLength(16);
    for (const ref of frontier) expect(world.map.x(ref)).toBe(3);
  });

  it('releases land when a player is removed', () => {
    const world = flatWorld(16, 16);
    world.addPlayer(0, 1000, 0);
    claim(world, 0, 2, 2, 5, 5);

    world.removePlayer(0);
    expect(world.map.ownerOf(world.map.ref(3, 3))).toBe(TILE_OWNER_NONE);
    expect(world.player(0)).toBeUndefined();
  });

  it('reports changed tiles once each', () => {
    const world = flatWorld(16, 16);
    world.addPlayer(0, 1000, 0);

    const ref = world.map.ref(5, 5);
    world.setOwner(ref, 0);
    world.setOwner(ref, TILE_OWNER_NONE);
    world.setOwner(ref, 0);

    const dirty = world.drainDirty();
    expect(dirty.filter((r) => r === ref)).toHaveLength(1);
    expect(world.changedCount).toBe(0);
  });
});

describe('Attack', () => {
  it('spreads outward from the shared border, not at random', () => {
    // The defining visual property: conquest must advance as a wave from the
    // existing front, or it looks like static rather than an invasion.
    const world = flatWorld(48, 48);
    world.addPlayer(0, 100_000, 0);
    world.addPlayer(1, 100, 0);

    claim(world, 0, 0, 0, 9, 47);
    claim(world, 1, 10, 0, 47, 47);

    const attack = new Attack({ attacker: 0, target: 1, troops: 50_000 });
    const rng = new Rng(1);
    attack.begin(world, rng, 0);

    for (let tick = 0; tick < 3; tick++) {
      attack.step(world, rng, tick, 0.1, world.player(1)!.troops);
    }

    // Everything taken must be near the original border, not scattered deep
    // inside the defender's territory.
    let maxX = 0;
    for (let ref = 0; ref < world.map.tileCount; ref++) {
      if (world.map.ownerOf(ref) === 0) maxX = Math.max(maxX, world.map.x(ref));
    }
    expect(maxX).toBeGreaterThan(9);
    expect(maxX).toBeLessThan(20);
  });

  it('takes ground over successive ticks', () => {
    const world = flatWorld(48, 48);
    world.addPlayer(0, 100_000, 0);
    world.addPlayer(1, 500, 0);

    claim(world, 0, 0, 0, 9, 47);
    claim(world, 1, 10, 0, 47, 47);

    const attack = new Attack({ attacker: 0, target: 1, troops: 60_000 });
    const rng = new Rng(2);
    attack.begin(world, rng, 0);

    const before = world.player(0)!.tilesOwned;
    for (let tick = 0; tick < 40; tick++) {
      attack.step(world, rng, tick, 0.1, world.player(1)!.troops);
    }

    expect(world.player(0)!.tilesOwned).toBeGreaterThan(before);
    expect(world.player(1)!.tilesOwned).toBeLessThan(48 * 38);
    expect(attack.tilesTaken).toBeGreaterThan(0);
  });

  it('advances faster across a wide front than a narrow one', () => {
    // Border shape must matter — a chokepoint should genuinely hold.
    const run = (frontHeight: number): number => {
      const world = flatWorld(48, 48);
      world.addPlayer(0, 100_000, 0);
      world.addPlayer(1, 1000, 0);

      claim(world, 0, 0, 0, 9, 47);
      // The defender only touches the attacker across `frontHeight` rows;
      // elsewhere a neutral gap separates them.
      claim(world, 1, 10, 0, 47, 47);
      for (let y = frontHeight; y < 48; y++) {
        for (let x = 0; x <= 9; x++) world.setOwner(world.map.ref(x, y), TILE_OWNER_NONE);
      }

      const attack = new Attack({ attacker: 0, target: 1, troops: 60_000 });
      const rng = new Rng(3);
      attack.begin(world, rng, 0);
      for (let tick = 0; tick < 12; tick++) {
        attack.step(world, rng, tick, 0.1, world.player(1)!.troops);
      }
      return attack.tilesTaken;
    };

    expect(run(48)).toBeGreaterThan(run(4));
  });

  it('collapses a surrounded pocket quickly', () => {
    // Exposure discount means encirclement emerges rather than being
    // special-cased.
    const world = flatWorld(32, 32);
    world.addPlayer(0, 100_000, 0);
    world.addPlayer(1, 10, 0);

    claim(world, 0, 0, 0, 31, 31);
    claim(world, 1, 14, 14, 17, 17);

    const attack = new Attack({ attacker: 0, target: 1, troops: 50_000 });
    const rng = new Rng(4);
    attack.begin(world, rng, 0);
    for (let tick = 0; tick < 20; tick++) {
      attack.step(world, rng, tick, 0.1, world.player(1)!.troops);
    }

    expect(world.player(1)!.tilesOwned).toBe(0);
  });

  it('expands into unclaimed land more cheaply than into an enemy', () => {
    const cost = (target: number, defenderTroops: number): number => {
      const world = flatWorld(48, 48);
      world.addPlayer(0, 100_000, 0);
      if (target !== TILE_OWNER_NONE) world.addPlayer(1, defenderTroops, 0);

      claim(world, 0, 0, 0, 9, 47);
      if (target !== TILE_OWNER_NONE) claim(world, 1, 10, 0, 47, 47);

      const attack = new Attack({ attacker: 0, target, troops: 10_000 });
      const rng = new Rng(5);
      attack.begin(world, rng, 0);
      for (let tick = 0; tick < 10; tick++) {
        attack.step(world, rng, tick, 0.1, defenderTroops);
      }
      return attack.tilesTaken === 0 ? 0 : (10_000 - attack.troops) / attack.tilesTaken;
    };

    // Expansion must be cheap, or nobody would ever claim neutral ground.
    expect(cost(TILE_OWNER_NONE, 0)).toBeLessThan(cost(1, 5000));
  });

  it('stops when the attacker runs out of troops', () => {
    const world = flatWorld(48, 48);
    world.addPlayer(0, 100_000, 0);
    world.addPlayer(1, 10_000, 0);

    claim(world, 0, 0, 0, 9, 47);
    claim(world, 1, 10, 0, 47, 47);

    const attack = new Attack({ attacker: 0, target: 1, troops: 20 });
    const rng = new Rng(6);
    attack.begin(world, rng, 0);
    for (let tick = 0; tick < 50; tick++) {
      attack.step(world, rng, tick, 0.1, world.player(1)!.troops);
    }

    expect(attack.isFinished).toBe(true);
    expect(attack.tilesTaken).toBeLessThan(40);
  });

  it('finishes immediately when the two players share no border', () => {
    const world = flatWorld(32, 32);
    world.addPlayer(0, 1000, 0);
    world.addPlayer(1, 1000, 0);

    claim(world, 0, 0, 0, 3, 3);
    claim(world, 1, 20, 20, 23, 23);

    const attack = new Attack({ attacker: 0, target: 1, troops: 500 });
    attack.begin(world, new Rng(7), 0);
    expect(attack.isFinished).toBe(true);
  });

  it('never conquers water', () => {
    const world = flatWorld(32, 32);
    // Carve a channel the attack would otherwise flow through.
    for (let y = 0; y < 32; y++) world.map.setWater(world.map.ref(16, y), 5);
    world.map.recountLand();

    world.addPlayer(0, 100_000, 0);
    world.addPlayer(1, 100, 0);
    claim(world, 0, 0, 0, 15, 31);
    for (let y = 0; y < 32; y++) {
      for (let x = 17; x < 32; x++) world.setOwner(world.map.ref(x, y), 1);
    }

    const attack = new Attack({ attacker: 0, target: 1, troops: 50_000 });
    const rng = new Rng(8);
    attack.begin(world, rng, 0);
    for (let tick = 0; tick < 30; tick++) {
      attack.step(world, rng, tick, 0.1, world.player(1)!.troops);
    }

    // Land armies must not cross water; that is what boats are for.
    for (let y = 0; y < 32; y++) {
      expect(world.map.ownerOf(world.map.ref(16, y))).toBe(TILE_OWNER_NONE);
    }
    expect(world.player(1)!.tilesOwned).toBe(15 * 32);
  });

  it('produces identical results for identical seeds', () => {
    // Lockstep requires this exactly: every client must reach the same state.
    const play = (): number[] => {
      const world = flatWorld(48, 48);
      world.addPlayer(0, 100_000, 0);
      world.addPlayer(1, 2000, 0);
      claim(world, 0, 0, 0, 9, 47);
      claim(world, 1, 10, 0, 47, 47);

      const attack = new Attack({ attacker: 0, target: 1, troops: 40_000 });
      const rng = new Rng(1234);
      attack.begin(world, rng, 0);
      for (let tick = 0; tick < 25; tick++) {
        attack.step(world, rng, tick, 0.1, world.player(1)!.troops);
      }
      return Array.from(world.map.owner);
    };

    expect(play()).toEqual(play());
  });

  it('sustains a large front within a tick budget', () => {
    const world = flatWorld(512, 512);
    world.addPlayer(0, 5_000_000, 0);
    world.addPlayer(1, 100_000, 0);
    claim(world, 0, 0, 0, 100, 511);
    claim(world, 1, 101, 0, 511, 511);

    const attack = new Attack({ attacker: 0, target: 1, troops: 2_000_000 });
    const rng = new Rng(99);
    attack.begin(world, rng, 0);

    const started = performance.now();
    for (let tick = 0; tick < 100; tick++) {
      attack.step(world, rng, tick, 0.05, world.player(1)!.troops);
    }
    const elapsed = performance.now() - started;

    expect(attack.tilesTaken).toBeGreaterThan(1000);
    // 100 ticks of a 512-tile-wide front. Guards against an accidental O(n²).
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('conquest tuning', () => {
  it('keeps the ratio multiplier bounded on both sides', () => {
    // Neither an overwhelming attacker nor a hopeless one should produce an
    // instant or infinitely slow result.
    expect(CONQUEST.minRatioMultiplier).toBeGreaterThan(0);
    expect(CONQUEST.maxRatioMultiplier).toBeGreaterThan(CONQUEST.minRatioMultiplier);
  });
});
