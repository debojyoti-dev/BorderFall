import { ECONOMY, GameMode, OWNER_NONE, RoomVisibility } from '@borderfall/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MatchInstance } from './MatchInstance.js';
import { registerCoreSystems } from '../systems/index.js';
import type { CombatSystem } from '../systems/CombatSystem.js';

/**
 * Whole-simulation tests.
 *
 * Drives a real match with synthetic time — no sockets, no wall clock. This is
 * what the "systems read `context.elapsedMs`, never `Date.now()`" rule buys:
 * a ten-minute match runs here in milliseconds, and the same harness will later
 * verify replays and drive load tests.
 */

function makeMatch(
  seed = 777,
  territoryCount = 400,
): { match: MatchInstance; combat: CombatSystem } {
  const match = new MatchInstance(
    {
      name: 'sim',
      mode: GameMode.FreeForAll,
      visibility: RoomVisibility.Public,
      password: undefined,
      maxPlayers: 8,
      territoryCount,
      seed,
      botCount: 0,
    },
    'SIM001',
  );
  const combat = registerCoreSystems(match);
  return { match, combat };
}

/**
 * Advances the simulation by feeding the scheduler synthetic time.
 *
 * Deliberately bypasses `match.start()`'s `setInterval`: real timers would make
 * these tests slow and flaky, and the scheduler is designed to accept time from
 * any source precisely so it can be driven like this.
 */
function advance(match: MatchInstance, totalMs: number, stepMs = 50): void {
  const steps = Math.floor(totalMs / stepMs);
  for (let i = 0; i < steps; i++) {
    match.scheduler.advance(
      stepMs,
      (system, tick, elapsedMs) => ({
        matchId: match.id,
        bus: match.bus,
        log: match.log,
        rng: match.simulationRng.fork(system.name),
        elapsedMs,
        tick,
      }),
      () => {},
    );
    match.bus.flush();
  }
}

describe('match simulation', () => {
  let active: MatchInstance | null = null;

  afterEach(() => {
    active?.dispose();
    active = null;
  });

  it('grows a seated player’s population and economy over time', () => {
    const { match } = makeMatch();
    active = match;
    match.start();

    const player = match.addPlayer('a', 'Alpha', false);
    expect(player).not.toBeNull();
    if (!player) return;

    const goldBefore = player.gold;
    const totalsBefore = match.world.totalsForSlot(player.slot);

    advance(match, 30_000);

    const totalsAfter = match.world.totalsForSlot(player.slot);
    expect(totalsAfter.population).toBeGreaterThan(totalsBefore.population);
    expect(totalsAfter.troops).toBeGreaterThan(totalsBefore.troops);
    expect(player.gold).toBeGreaterThan(goldBefore);
  });

  it('leaves neutral territory untouched', () => {
    const { match } = makeMatch();
    active = match;
    match.start();
    match.addPlayer('a', 'Alpha', false);

    // Pick a neutral land tile and confirm the simulation ignores it.
    let neutral = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (match.reader.isLand(id) && match.world.isNeutral(id)) {
        neutral = id;
        break;
      }
    }
    expect(neutral).toBeGreaterThanOrEqual(0);

    advance(match, 20_000);

    expect(match.world.getOwner(neutral)).toBe(OWNER_NONE);
    expect(match.world.population[neutral]).toBe(0);
  });

  it('resolves a full attack through the tick pipeline', () => {
    const { match, combat } = makeMatch();
    active = match;
    match.start();

    const player = match.addPlayer('a', 'Alpha', false);
    if (!player) return;

    // Find the player's spawn and a neutral land neighbour.
    let from = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (match.world.getOwner(id) === player.slot) {
        from = id;
        break;
      }
    }
    expect(from).toBeGreaterThanOrEqual(0);

    let to = -1;
    const degree = match.reader.getNeighbourCount(from);
    for (let k = 0; k < degree; k++) {
      const neighbour = match.reader.getNeighbourAt(from, k);
      if (match.reader.isLand(neighbour) && match.world.isNeutral(neighbour)) {
        to = neighbour;
        break;
      }
    }
    if (to < 0) return; // Island spawn.

    // Build up an army first.
    advance(match, 20_000);
    const troops = match.world.troops[from] as number;
    expect(troops).toBeGreaterThan(10);

    const committed = Math.floor(troops * 0.6);
    match.world.setTroops(from, troops - committed);
    match.bus.emit('combat:attack-launched', {
      from,
      to,
      attackerSlot: player.slot,
      troops: committed,
      arrivesAt: match.elapsedSimMs + combat.travelTimeMs(from, to),
    });
    match.bus.flush();

    // Not yet — the army is still in transit.
    expect(match.world.getOwner(to)).toBe(OWNER_NONE);

    advance(match, 15_000);

    expect(match.world.getOwner(to)).toBe(player.slot);
    expect(player.territoriesCaptured).toBe(1);
  });

  it('lets a captured territory recover population from zero', () => {
    const { match } = makeMatch();
    active = match;
    match.start();

    const player = match.addPlayer('a', 'Alpha', false);
    if (!player) return;

    let owned = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (match.world.getOwner(id) === player.slot) {
        owned = id;
        break;
      }
    }
    match.world.setPopulation(owned, 0);

    advance(match, 20_000);

    // Without a growth floor, conquest would leave permanently dead land.
    expect(match.world.population[owned]).toBeGreaterThan(0);
  });

  it('produces identical results for the same seed', () => {
    // The property replays and load tests depend on.
    const play = (): number[] => {
      const { match } = makeMatch(9090);
      match.start();
      const player = match.addPlayer('a', 'Alpha', false);
      advance(match, 20_000);
      const totals = match.world.totalsForSlot(player?.slot ?? 0);
      match.dispose();
      return [totals.population, totals.troops, Math.round((player?.gold ?? 0) * 1000)];
    };

    expect(play()).toEqual(play());
  });

  it('stays within the tick budget at full world size', () => {
    const { match } = makeMatch(4242, 5000);
    active = match;
    match.start();

    for (let i = 0; i < 8; i++) match.addPlayer(`p${i}`, `Player ${i}`, false);

    const started = performance.now();
    advance(match, 10_000);
    const elapsed = performance.now() - started;

    // 10 s of simulation across 5 000 territories and 8 players. Generous —
    // this guards against an accidental O(n²), not against a few percent.
    expect(elapsed).toBeLessThan(4000);
  });

  it('caps resources rather than overflowing', () => {
    const { match } = makeMatch();
    active = match;
    match.start();

    const player = match.addPlayer('a', 'Alpha', false);
    if (!player) return;
    player.gold = ECONOMY.maxGold;

    advance(match, 5000);
    expect(player.gold).toBeLessThanOrEqual(ECONOMY.maxGold);
  });
});
