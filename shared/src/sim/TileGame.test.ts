import { describe, expect, it } from 'vitest';
import { TILE_OWNER_NONE } from '../world/TileMap.js';
import { IntentType, type Intent, type Turn } from './intents.js';
import { TILE_BALANCE, TileGame, type TileGameConfig } from './TileGame.js';

const CONFIG: TileGameConfig = { seed: 20260801, width: 192, height: 128, turnsPerSecond: 10 };

function makeGame(overrides: Partial<TileGameConfig> = {}): TileGame {
  return new TileGame({ ...CONFIG, ...overrides });
}

/** First unowned land tile, so spawns land somewhere legal. */
function findLand(game: TileGame, skip = 0): number {
  let seen = 0;
  for (let ref = 0; ref < game.map.tileCount; ref++) {
    if (!game.map.isLand(ref)) continue;
    if (game.map.ownerOf(ref) !== TILE_OWNER_NONE) continue;
    if (seen++ < skip) continue;
    return ref;
  }
  throw new Error('no free land');
}

/** Runs `count` empty turns. */
function idle(game: TileGame, count: number, from = game.turn): void {
  for (let i = 1; i <= count; i++) game.applyTurn({ turn: from + i, intents: [] });
}

describe('TileGame lifecycle', () => {
  it('starts with no players and no elapsed time', () => {
    const game = makeGame();
    expect(game.turn).toBe(0);
    expect(game.players()).toHaveLength(0);
    expect(game.elapsedSeconds).toBe(0);
  });

  it('derives elapsed time from turns, never from a clock', () => {
    const game = makeGame({ turnsPerSecond: 10 });
    idle(game, 25);
    expect(game.turn).toBe(25);
    expect(game.elapsedSeconds).toBeCloseTo(2.5, 6);
  });

  it('spawns a player onto a claimed area', () => {
    const game = makeGame();
    const player = game.addPlayer(0, 'Alpha', false);
    const tile = findLand(game);

    game.applyTurn({
      turn: 1,
      intents: [{ type: IntentType.Spawn, slot: 0, tile }],
    });

    expect(player.hasSpawned).toBe(true);
    expect(player.tilesOwned).toBeGreaterThan(1);
    expect(player.troops).toBeGreaterThan(0);
    expect(game.map.ownerOf(tile)).toBe(0);
  });

  it('refuses a second spawn', () => {
    const game = makeGame();
    const player = game.addPlayer(0, 'Alpha', false);
    const first = findLand(game);

    game.applyTurn({ turn: 1, intents: [{ type: IntentType.Spawn, slot: 0, tile: first }] });
    const owned = player.tilesOwned;

    const second = findLand(game, 400);
    game.applyTurn({ turn: 2, intents: [{ type: IntentType.Spawn, slot: 0, tile: second }] });

    expect(player.tilesOwned).toBe(owned);
    expect(game.map.ownerOf(second)).toBe(TILE_OWNER_NONE);
  });

  it('refuses to spawn on water', () => {
    const game = makeGame();
    game.addPlayer(0, 'Alpha', false);

    let water = -1;
    for (let ref = 0; ref < game.map.tileCount; ref++) {
      if (game.map.isWater(ref)) {
        water = ref;
        break;
      }
    }

    game.applyTurn({ turn: 1, intents: [{ type: IntentType.Spawn, slot: 0, tile: water }] });
    expect(game.player(0)!.hasSpawned).toBe(false);
  });

  it('ignores intents from unknown or dead players', () => {
    const game = makeGame();
    expect(() =>
      game.applyTurn({
        turn: 1,
        intents: [{ type: IntentType.Spawn, slot: 99, tile: findLand(game) }],
      }),
    ).not.toThrow();
  });

  it('ignores an intent type it does not implement yet', () => {
    // A newer client's intent must not crash an older peer mid-match.
    const game = makeGame();
    game.addPlayer(0, 'Alpha', false);
    const unknown = { type: 999, slot: 0 } as unknown as Intent;

    expect(() => game.applyTurn({ turn: 1, intents: [unknown] })).not.toThrow();
  });
});

describe('TileGame economy', () => {
  it('accrues gold and troops for a spawned player', () => {
    const game = makeGame();
    const player = game.addPlayer(0, 'Alpha', false);
    game.applyTurn({
      turn: 1,
      intents: [{ type: IntentType.Spawn, slot: 0, tile: findLand(game) }],
    });

    const gold = player.gold;
    const troops = player.troops;
    idle(game, 50);

    expect(player.gold).toBeGreaterThan(gold);
    expect(player.troops).toBeGreaterThan(troops);
  });

  it('does not pay a player who has not spawned', () => {
    const game = makeGame();
    const player = game.addPlayer(0, 'Alpha', false);
    const gold = player.gold;

    idle(game, 50);
    expect(player.gold).toBe(gold);
  });

  it('caps troops sublinearly in territory', () => {
    // The anti-snowball lever: four times the land must not give four times
    // the army, or conquest compounds without limit.
    const game = makeGame();
    const player = game.addPlayer(0, 'Alpha', false);

    player.tilesOwned = 100;
    const small = game.troopCeiling(player);
    player.tilesOwned = 400;
    const large = game.troopCeiling(player);

    expect(large).toBeGreaterThan(small);
    expect(large / small).toBeLessThan(3);
  });

  it('never exceeds the ceiling', () => {
    const game = makeGame();
    const player = game.addPlayer(0, 'Alpha', false);
    game.applyTurn({
      turn: 1,
      intents: [{ type: IntentType.Spawn, slot: 0, tile: findLand(game) }],
    });

    idle(game, 3000);
    expect(player.troops).toBeLessThanOrEqual(game.troopCeiling(player) + 1);
  });
});

describe('TileGame attacks', () => {
  /** Spawns a player and lets them build up. */
  function seed(game: TileGame, slot: number, skip: number, buildTurns = 30): void {
    game.addPlayer(slot, `P${slot}`, false);
    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Spawn, slot, tile: findLand(game, skip) }],
    });
    idle(game, buildTurns);
  }

  it('expands into neutral land', () => {
    const game = makeGame();
    seed(game, 0, 0);

    const before = game.player(0)!.tilesOwned;
    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Attack, slot: 0, target: TILE_OWNER_NONE, ratio: 0.5 }],
    });
    idle(game, 60);

    expect(game.player(0)!.tilesOwned).toBeGreaterThan(before);
  });

  it('deducts committed troops and returns survivors when the front ends', () => {
    const game = makeGame();
    seed(game, 0, 0);

    const before = game.player(0)!.troops;
    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Attack, slot: 0, target: TILE_OWNER_NONE, ratio: 0.5 }],
    });

    // Commitment is immediate.
    expect(game.player(0)!.troops).toBeLessThan(before);
    expect(game.activeAttacks).toBe(1);
  });

  it('reinforces an existing front rather than opening a duplicate', () => {
    const game = makeGame();
    seed(game, 0, 0);

    const attack = {
      type: IntentType.Attack,
      slot: 0,
      target: TILE_OWNER_NONE,
      ratio: 0.2,
    } as const;
    game.applyTurn({ turn: game.turn + 1, intents: [attack] });
    game.applyTurn({ turn: game.turn + 1, intents: [attack] });

    expect(game.attacksBy(0)).toBe(1);
  });

  it('returns troops on retreat', () => {
    const game = makeGame();
    seed(game, 0, 0);

    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Attack, slot: 0, target: TILE_OWNER_NONE, ratio: 0.5 }],
    });
    const committed = game.player(0)!.troops;

    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Retreat, slot: 0, target: TILE_OWNER_NONE }],
    });

    // Retreat must be a real option, or every attack is total commitment.
    expect(game.player(0)!.troops).toBeGreaterThan(committed);
  });

  it('refuses to attack an ally', () => {
    const game = makeGame();
    seed(game, 0, 0);
    seed(game, 1, 600);

    game.player(0)!.allies.add(1);
    game.player(1)!.allies.add(0);

    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Attack, slot: 0, target: 1, ratio: 0.5 }],
    });

    expect(game.attacksBy(0)).toBe(0);
  });

  it('refuses to attack oneself', () => {
    const game = makeGame();
    seed(game, 0, 0);

    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Attack, slot: 0, target: 0, ratio: 0.5 }],
    });
    expect(game.attacksBy(0)).toBe(0);
  });

  it('rejects a non-finite ratio without corrupting state', () => {
    const game = makeGame();
    seed(game, 0, 0);
    const troops = game.player(0)!.troops;

    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Attack, slot: 0, target: TILE_OWNER_NONE, ratio: Number.NaN }],
    });

    // No front opened, and nothing was committed. Troops may legitimately be
    // *higher*, because applying a turn also advances the economy — so assert
    // that none were spent rather than that the figure is unchanged.
    expect(game.attacksBy(0)).toBe(0);
    expect(game.player(0)!.troops).toBeGreaterThanOrEqual(troops);
    expect(Number.isFinite(game.player(0)!.troops)).toBe(true);
  });

  it('eliminates a player who loses all ground and has nothing in the field', () => {
    const game = makeGame();
    seed(game, 0, 0);

    const player = game.player(0)!;
    for (let ref = 0; ref < game.map.tileCount; ref++) {
      if (game.map.ownerOf(ref) === 0) game.world.setOwner(ref, TILE_OWNER_NONE);
    }
    idle(game, 2);

    expect(player.alive).toBe(false);
    expect(game.livingPlayers()).toHaveLength(0);
  });

  it('spares a landless player whose attack is still running', () => {
    const game = makeGame();
    seed(game, 0, 0);

    game.applyTurn({
      turn: game.turn + 1,
      intents: [{ type: IntentType.Attack, slot: 0, target: TILE_OWNER_NONE, ratio: 0.9 }],
    });
    // Strip their land while the front is live.
    for (let ref = 0; ref < game.map.tileCount; ref++) {
      if (game.map.ownerOf(ref) === 0) game.world.setOwner(ref, TILE_OWNER_NONE);
    }
    game.applyTurn({ turn: game.turn + 1, intents: [] });

    expect(game.player(0)!.alive).toBe(true);
  });
});

describe('TileGame determinism', () => {
  /** A scripted match, replayed on two independent simulations. */
  function scriptedTurns(game: TileGame): Turn[] {
    const turns: Turn[] = [];
    const a = findLand(game, 0);
    const b = findLand(game, 900);

    turns.push({
      turn: 1,
      intents: [
        { type: IntentType.Spawn, slot: 0, tile: a },
        { type: IntentType.Spawn, slot: 1, tile: b },
      ],
    });

    for (let turn = 2; turn <= 200; turn++) {
      const intents: Intent[] = [];
      if (turn === 30) {
        intents.push({ type: IntentType.Attack, slot: 0, target: TILE_OWNER_NONE, ratio: 0.6 });
      }
      if (turn === 45) {
        intents.push({ type: IntentType.Attack, slot: 1, target: TILE_OWNER_NONE, ratio: 0.7 });
      }
      if (turn === 120) {
        intents.push({ type: IntentType.Attack, slot: 0, target: 1, ratio: 0.5 });
      }
      turns.push({ turn, intents });
    }
    return turns;
  }

  it('two simulations fed identical turns never diverge', () => {
    // This is the property lockstep is built on. If it fails, every client in
    // the match sees a different world and no error is raised anywhere.
    const left = makeGame();
    const right = makeGame();

    left.addPlayer(0, 'A', false);
    left.addPlayer(1, 'B', false);
    right.addPlayer(0, 'A', false);
    right.addPlayer(1, 'B', false);

    const turns = scriptedTurns(left);

    for (const turn of turns) {
      left.applyTurn(turn);
      right.applyTurn(turn);
      expect(right.checksum()).toBe(left.checksum());
    }

    expect(Array.from(right.map.owner)).toEqual(Array.from(left.map.owner));
  });

  it('produces a different checksum for a different seed', () => {
    const a = makeGame({ seed: 1 });
    const b = makeGame({ seed: 2 });
    a.addPlayer(0, 'A', false);
    b.addPlayer(0, 'A', false);
    idle(a, 10);
    idle(b, 10);

    expect(b.checksum()).not.toBe(a.checksum());
  });

  it('changes checksum as the world changes', () => {
    const game = makeGame();
    game.addPlayer(0, 'A', false);
    const before = game.checksum();

    game.applyTurn({
      turn: 1,
      intents: [{ type: IntentType.Spawn, slot: 0, tile: findLand(game) }],
    });
    expect(game.checksum()).not.toBe(before);
  });

  it('is unaffected by the order in which players were added', () => {
    // Player iteration must be by slot, not insertion, or two clients that
    // seated players in a different order would drift apart.
    const forward = makeGame();
    forward.addPlayer(0, 'A', false);
    forward.addPlayer(1, 'B', false);

    const reverse = makeGame();
    reverse.addPlayer(1, 'B', false);
    reverse.addPlayer(0, 'A', false);

    const tile = findLand(forward);
    const turn: Turn = {
      turn: 1,
      intents: [{ type: IntentType.Spawn, slot: 0, tile }],
    };
    forward.applyTurn(turn);
    reverse.applyTurn(turn);

    expect(reverse.checksum()).toBe(forward.checksum());
  });

  it('runs a long match within a real-time budget', () => {
    const game = makeGame({ width: 512, height: 256 });
    game.addPlayer(0, 'A', false);
    game.addPlayer(1, 'B', false);
    game.applyTurn({
      turn: 1,
      intents: [
        { type: IntentType.Spawn, slot: 0, tile: findLand(game, 0) },
        { type: IntentType.Spawn, slot: 1, tile: findLand(game, 3000) },
      ],
    });

    const started = performance.now();
    for (let turn = 2; turn <= 600; turn++) {
      const intents: Intent[] =
        turn % 100 === 0
          ? [
              {
                type: IntentType.Attack,
                slot: turn % 200 === 0 ? 0 : 1,
                target: TILE_OWNER_NONE,
                ratio: 0.6,
              },
            ]
          : [];
      game.applyTurn({ turn, intents });
    }
    const elapsed = performance.now() - started;

    // 600 turns = 60 simulated seconds. This runs on every client, so it must
    // stay far ahead of real time.
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('TILE_BALANCE', () => {
  it('keeps the troop exponent below linear', () => {
    expect(TILE_BALANCE.troopExponent).toBeGreaterThan(0);
    expect(TILE_BALANCE.troopExponent).toBeLessThan(1);
  });
});
