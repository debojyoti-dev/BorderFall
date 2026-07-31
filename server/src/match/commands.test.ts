import { GameMode, OWNER_NONE, RejectReason, RoomVisibility } from '@borderfall/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MatchInstance } from './MatchInstance.js';
import type { Player } from './PlayerRegistry.js';
import { resolveAttack, validateAttack, validateTransfer, type CooldownMap } from './commands.js';

/**
 * Command validation is the security boundary. These tests assume a hostile
 * client: every case here is something a modified client would try.
 */
function makeMatch(): MatchInstance {
  const match = new MatchInstance(
    {
      name: 'test',
      mode: GameMode.FreeForAll,
      visibility: RoomVisibility.Public,
      password: undefined,
      maxPlayers: 8,
      territoryCount: 400,
      seed: 4242,
      botCount: 0,
    },
    'TEST01',
  );
  match.start();
  return match;
}

/** Finds a land territory with at least one land neighbour. */
function findLandPair(match: MatchInstance): { from: number; to: number } {
  for (let id = 0; id < match.world.territoryCount; id++) {
    if (!match.reader.isLand(id)) continue;
    const count = match.reader.getNeighbourCount(id);
    for (let k = 0; k < count; k++) {
      const neighbour = match.reader.getNeighbourAt(id, k);
      if (match.reader.isLand(neighbour)) return { from: id, to: neighbour };
    }
  }
  throw new Error('No adjacent land pair in generated world');
}

describe('command validation', () => {
  let match: MatchInstance;
  let player: Player;
  let cooldowns: CooldownMap;
  let from: number;
  let to: number;

  beforeEach(() => {
    match = new MatchInstance(
      {
        name: 'test',
        mode: GameMode.FreeForAll,
        visibility: RoomVisibility.Public,
        password: undefined,
        maxPlayers: 8,
        territoryCount: 400,
        seed: 4242,
        botCount: 0,
      },
      'TEST01',
    );
    match.start();

    const created = match.players.add('acct-1', 'Tester', false, Date.now());
    if (!created) throw new Error('Could not seat player');
    player = created;

    const pair = findLandPair(match);
    from = pair.from;
    to = pair.to;

    match.world.setOwner(from, player.slot);
    match.world.setTroops(from, 100);
    match.world.setOwner(to, OWNER_NONE);
    match.world.setTroops(to, 0);

    cooldowns = new Map();
  });

  // MatchInstance holds a live interval; leaking it would keep the process
  // alive after the suite finishes.
  afterEach(() => match.dispose());

  it('accepts a legal attack', () => {
    const result = validateAttack(match, player, { seq: 1, from, to, ratio: 0.5 }, cooldowns, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.troops).toBe(50);
  });

  it('rejects attacking from a territory you do not own', () => {
    match.world.setOwner(from, OWNER_NONE);
    const result = validateAttack(match, player, { seq: 1, from, to, ratio: 0.5 }, cooldowns, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.NotOwner);
  });

  it('rejects a non-adjacent target', () => {
    // The single most valuable check here: without it a modified client could
    // strike anywhere on the map.
    let distant = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (
        id !== from &&
        id !== to &&
        match.reader.isLand(id) &&
        !match.reader.areNeighbours(from, id)
      ) {
        distant = id;
        break;
      }
    }
    expect(distant).toBeGreaterThanOrEqual(0);

    const result = validateAttack(
      match,
      player,
      { seq: 1, from, to: distant, ratio: 0.5 },
      cooldowns,
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.NotAdjacent);
  });

  it('rejects out-of-range territory ids', () => {
    for (const bad of [-1, 999_999, 1.5, Number.NaN]) {
      const result = validateAttack(
        match,
        player,
        { seq: 1, from: bad, to, ratio: 0.5 },
        cooldowns,
        0,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(RejectReason.UnknownTerritory);
    }
  });

  it('rejects an out-of-range ratio', () => {
    for (const ratio of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateAttack(match, player, { seq: 1, from, to, ratio }, cooldowns, 0);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects attacking yourself', () => {
    const result = validateAttack(
      match,
      player,
      { seq: 1, from, to: from, ratio: 0.5 },
      cooldowns,
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.SelfTargeted);
  });

  it('rejects attacking a territory you already own', () => {
    match.world.setOwner(to, player.slot);
    const result = validateAttack(match, player, { seq: 1, from, to, ratio: 0.5 }, cooldowns, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.AlreadyOwned);
  });

  it('rejects a land attack against water', () => {
    let water = -1;
    const count = match.reader.getNeighbourCount(from);
    for (let k = 0; k < count; k++) {
      const neighbour = match.reader.getNeighbourAt(from, k);
      if (match.reader.isWater(neighbour)) {
        water = neighbour;
        break;
      }
    }

    if (water >= 0) {
      const result = validateAttack(
        match,
        player,
        { seq: 1, from, to: water, ratio: 0.5 },
        cooldowns,
        0,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(RejectReason.InvalidTerrain);
    }
  });

  it('rejects committing the entire garrison', () => {
    // A territory must always retain a garrison, or land would flip back and
    // forth with zero defence.
    match.world.setTroops(from, 1);
    const result = validateAttack(match, player, { seq: 1, from, to, ratio: 1 }, cooldowns, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.InsufficientTroops);
  });

  it('enforces the per-territory cooldown', () => {
    cooldowns.set(from, 5000);
    const result = validateAttack(match, player, { seq: 1, from, to, ratio: 0.5 }, cooldowns, 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.CooldownActive);

    const later = validateAttack(match, player, { seq: 1, from, to, ratio: 0.5 }, cooldowns, 6000);
    expect(later.ok).toBe(true);
  });

  it('rejects attacking an ally', () => {
    const ally = match.players.add('acct-2', 'Ally', false, Date.now());
    if (!ally) throw new Error('Could not seat ally');
    player.allianceId = 1;
    ally.allianceId = 1;
    match.world.setOwner(to, ally.slot);

    const result = validateAttack(match, player, { seq: 1, from, to, ratio: 0.5 }, cooldowns, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.TargetIsAlly);
  });

  it('rejects transfers to a territory that is neither yours nor an ally’s', () => {
    const enemy = match.players.add('acct-3', 'Enemy', false, Date.now());
    if (!enemy) throw new Error('Could not seat enemy');
    match.world.setOwner(to, enemy.slot);

    const result = validateTransfer(match, player, { seq: 1, from, to, ratio: 0.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.NotOwner);
  });

  it('accepts a transfer to your own adjacent territory', () => {
    match.world.setOwner(to, player.slot);
    const result = validateTransfer(match, player, { seq: 1, from, to, ratio: 0.4 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.troops).toBe(40);
  });
});

describe('attack resolution', () => {
  it('captures an undefended neutral territory', () => {
    const match = makeMatch();
    const player = match.players.add('a', 'A', false, Date.now())!;
    const { from, to } = findLandPair(match);

    match.world.setOwner(from, player.slot);
    match.world.setTroops(from, 100);
    match.world.setOwner(to, OWNER_NONE);
    match.world.setTroops(to, 0);

    const result = resolveAttack(match, player, from, to, 50, 0.5);

    expect(result.captured).toBe(true);
    expect(match.world.getOwner(to)).toBe(player.slot);
    expect(match.world.troops[to]).toBeGreaterThan(0);
    // The committed troops must leave the source regardless of outcome.
    expect(match.world.troops[from]).toBe(50);
    match.dispose();
  });

  it('fails against an overwhelming defender and does not transfer ownership', () => {
    const match = makeMatch();
    const player = match.players.add('a', 'A', false, Date.now())!;
    const defender = match.players.add('b', 'B', false, Date.now())!;
    const { from, to } = findLandPair(match);

    match.world.setOwner(from, player.slot);
    match.world.setTroops(from, 100);
    match.world.setOwner(to, defender.slot);
    match.world.setTroops(to, 10_000);

    const result = resolveAttack(match, player, from, to, 50, 0.5);

    expect(result.captured).toBe(false);
    expect(match.world.getOwner(to)).toBe(defender.slot);
    match.dispose();
  });

  it('credits kills and losses on capture', () => {
    const match = makeMatch();
    const attacker = match.players.add('a', 'A', false, Date.now())!;
    const defender = match.players.add('b', 'B', false, Date.now())!;
    const { from, to } = findLandPair(match);

    match.world.setOwner(from, attacker.slot);
    match.world.setTroops(from, 1000);
    match.world.setOwner(to, defender.slot);
    match.world.setTroops(to, 1);

    resolveAttack(match, attacker, from, to, 900, 0.5);

    expect(attacker.kills).toBe(1);
    expect(attacker.territoriesCaptured).toBe(1);
    expect(defender.deaths).toBe(1);
    expect(defender.territoriesLost).toBe(1);
    match.dispose();
  });
});
