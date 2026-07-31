import {
  ECONOMY,
  OWNER_NONE,
  POPULATION,
  PlayerStatus,
  Rng,
  WorldReader,
  createMapParams,
  generateWorld,
  type WorldGeometry,
} from '@borderfall/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../engine/EventBus.js';
import { WorldState } from '../engine/WorldState.js';
import { createLogger } from '../utils/logger.js';
import type { SystemContext } from '../engine/System.js';
import { PlayerRegistry, type Player } from '../match/PlayerRegistry.js';
import { CombatSystem } from './CombatSystem.js';
import { EconomySystem } from './EconomySystem.js';
import { PopulationSystem } from './PopulationSystem.js';
import { VictorySystem } from './VictorySystem.js';
import { populationCapacity } from './modifiers.js';

/**
 * Systems are tested without a match, a socket or a clock: a world, a registry
 * and a hand-driven context is the whole harness. That is the payoff of
 * injecting `SystemContext` rather than importing globals.
 */
const geometry: WorldGeometry = generateWorld(
  createMapParams(31337, { territoryCount: 400, width: 2048, height: 2048 }),
);

function makeContext(bus: EventBus, elapsedMs = 0, tick = 0, seed = 1): SystemContext {
  return {
    matchId: 'test',
    bus,
    log: createLogger('test'),
    rng: new Rng(seed),
    elapsedMs,
    tick,
  };
}

/** Fresh reader over the shared geometry. */
function reader(): WorldReader {
  return new WorldReader(geometry);
}

/** First land territory, so tests never accidentally operate on ocean. */
function firstLand(reader: WorldReader): number {
  for (let id = 0; id < reader.territoryCount; id++) {
    if (reader.isLand(id)) return id;
  }
  throw new Error('No land in generated world');
}

/** A land territory adjacent to another land territory. */
function landPair(reader: WorldReader): { from: number; to: number } {
  for (let id = 0; id < reader.territoryCount; id++) {
    if (!reader.isLand(id)) continue;
    const degree = reader.getNeighbourCount(id);
    for (let k = 0; k < degree; k++) {
      const neighbour = reader.getNeighbourAt(id, k);
      if (reader.isLand(neighbour)) return { from: id, to: neighbour };
    }
  }
  throw new Error('No adjacent land pair');
}

describe('PopulationSystem', () => {
  let world: WorldState;
  let reader: WorldReader;
  let bus: EventBus;
  let system: PopulationSystem;
  let land: number;

  beforeEach(() => {
    world = new WorldState(geometry);
    reader = new WorldReader(geometry);
    bus = new EventBus();
    system = new PopulationSystem(world, reader);
    land = firstLand(reader);
  });

  it('grows an owned territory', () => {
    world.setOwner(land, 0);
    world.setPopulation(land, 100);

    system.update(makeContext(bus), 1000);
    expect(world.population[land]).toBeGreaterThan(100);
  });

  it('leaves unowned territory alone', () => {
    world.setPopulation(land, 100);
    system.update(makeContext(bus), 1000);

    // Neutral growth would hand a windfall to whoever took the land last.
    expect(world.population[land]).toBe(100);
  });

  it('never exceeds the territory capacity', () => {
    world.setOwner(land, 0);
    const capacity = populationCapacity(world, reader, land);
    world.setPopulation(land, capacity * 0.99);

    for (let i = 0; i < 200; i++) system.update(makeContext(bus), 1000);
    expect(world.population[land]).toBeLessThanOrEqual(Math.ceil(capacity));
  });

  it('slows as it approaches capacity', () => {
    // The defining property of logistic growth, and the reason wide empires
    // are not automatically unbeatable.
    world.setOwner(land, 0);
    const capacity = populationCapacity(world, reader, land);

    world.setPopulation(land, capacity * 0.1);
    const before = world.population[land] as number;
    system.update(makeContext(bus), 1000);
    const earlyGrowth = (world.population[land] as number) - before;

    world.setPopulation(land, capacity * 0.95);
    const late = world.population[land] as number;
    system.update(makeContext(bus), 1000);
    const lateGrowth = (world.population[land] as number) - late;

    expect(lateGrowth).toBeLessThan(earlyGrowth);
  });

  it('recovers a territory from zero population', () => {
    // The logistic term is proportional to current population, so without a
    // floor a captured territory at zero would stay dead forever.
    world.setOwner(land, 0);
    world.setPopulation(land, 0);

    for (let i = 0; i < 10; i++) system.update(makeContext(bus), 1000);
    expect(world.population[land]).toBeGreaterThan(0);
  });

  it('produces troops from population', () => {
    world.setOwner(land, 0);
    world.setPopulation(land, 1000);
    world.setTroops(land, 0);

    system.update(makeContext(bus), 1000);
    expect(world.troops[land]).toBeGreaterThan(0);
  });

  it('caps troops relative to population', () => {
    world.setOwner(land, 0);
    world.setPopulation(land, 1000);
    world.setTroops(land, 0);

    for (let i = 0; i < 500; i++) system.update(makeContext(bus), 1000);

    const ceiling = (world.population[land] as number) * POPULATION.mobilisationRate * 10;
    expect(world.troops[land]).toBeLessThanOrEqual(Math.ceil(ceiling));
  });

  it('is deterministic for identical input', () => {
    const run = (): number[] => {
      const localWorld = new WorldState(geometry);
      const localSystem = new PopulationSystem(localWorld, reader);
      localWorld.setOwner(land, 0);
      localWorld.setPopulation(land, 250);
      for (let i = 0; i < 20; i++) localSystem.update(makeContext(new EventBus()), 1000);
      return [localWorld.population[land] as number, localWorld.troops[land] as number];
    };
    expect(run()).toEqual(run());
  });
});

describe('EconomySystem', () => {
  let world: WorldState;
  let reader: WorldReader;
  let bus: EventBus;
  let players: PlayerRegistry;
  let system: EconomySystem;
  let player: Player;
  let land: number;

  beforeEach(() => {
    world = new WorldState(geometry);
    reader = new WorldReader(geometry);
    bus = new EventBus();
    players = new PlayerRegistry(8);
    system = new EconomySystem(world, reader, players);

    const created = players.add('acct', 'Tester', false, 0);
    if (!created) throw new Error('could not seat player');
    player = created;

    land = firstLand(reader);
    world.setOwner(land, player.slot);
    world.setPopulation(land, 5000);
  });

  it('accrues gold from population and territory', () => {
    const before = player.gold;
    system.update(makeContext(bus), 1000);
    expect(player.gold).toBeGreaterThan(before);
  });

  it('accrues food from population', () => {
    const before = player.food;
    system.update(makeContext(bus), 1000);
    expect(player.food).toBeGreaterThan(before);
  });

  it('charges food upkeep for troops', () => {
    world.setTroops(land, 100);
    system.update(makeContext(bus), 1000);
    const withSmallArmy = player.food;

    player.food = ECONOMY.startingFood;
    world.setTroops(land, 2_000_000);
    system.update(makeContext(bus), 1000);

    // A large army must cost more food than a small one.
    expect(player.food).toBeLessThan(withSmallArmy);
  });

  it('starves troops when food runs out', () => {
    world.setTroops(land, 5_000_000);
    player.food = 0;

    system.update(makeContext(bus), 1000);
    bus.flush();

    // Over-extension must be self-correcting, or food is a resource players
    // can simply ignore.
    expect(world.troops[land]).toBeLessThan(5_000_000);
  });

  it('emits a bankruptcy event when starving', () => {
    let bankrupt = false;
    bus.on('economy:bankrupt', () => {
      bankrupt = true;
    });

    world.setTroops(land, 5_000_000);
    player.food = 0;
    system.update(makeContext(bus), 1000);
    bus.flush();

    expect(bankrupt).toBe(true);
  });

  it('never lets resources go negative', () => {
    world.setTroops(land, 10_000_000);
    player.food = 0;
    for (let i = 0; i < 20; i++) system.update(makeContext(bus), 1000);

    expect(player.food).toBeGreaterThanOrEqual(0);
    expect(player.gold).toBeGreaterThanOrEqual(0);
  });

  it('ignores territories owned by nobody', () => {
    world.setOwner(land, OWNER_NONE);
    const before = player.gold;
    system.update(makeContext(bus), 1000);
    expect(player.gold).toBe(before);
  });
});

describe('CombatSystem', () => {
  let world: WorldState;
  let reader: WorldReader;
  let bus: EventBus;
  let players: PlayerRegistry;
  let combat: CombatSystem;
  let attacker: Player;
  let from: number;
  let to: number;

  beforeEach(() => {
    world = new WorldState(geometry);
    reader = new WorldReader(geometry);
    bus = new EventBus();
    players = new PlayerRegistry(8);
    combat = new CombatSystem(world, reader, players);
    combat.init(makeContext(bus));

    const created = players.add('a', 'Attacker', false, 0);
    if (!created) throw new Error('could not seat');
    attacker = created;

    const pair = landPair(reader);
    from = pair.from;
    to = pair.to;

    world.setOwner(from, attacker.slot);
    world.setTroops(from, 500);
  });

  /** Emits a launch event and flushes, as the router would. */
  function launch(troops: number, arrivesAt: number): void {
    bus.emit('combat:attack-launched', {
      from,
      to,
      attackerSlot: attacker.slot,
      troops,
      arrivesAt,
    });
    bus.flush();
  }

  /** Advances the system, flushing the bus after each tick. */
  function run(ticks: number, startMs = 0): void {
    for (let i = 0; i < ticks; i++) {
      combat.update(makeContext(bus, startMs + i * 100, i), 100);
      bus.flush();
    }
  }

  it('does not resolve before the army arrives', () => {
    launch(200, 5000);
    run(5);

    // Transit time is what gives a defender a window to respond.
    expect(world.getOwner(to)).not.toBe(attacker.slot);
    expect(combat.activeArmies).toBe(1);
  });

  it('marks the target contested while an attack is inbound', () => {
    launch(200, 5000);
    expect(world.contested[to]).toBe(1);
  });

  it('captures an undefended territory on arrival', () => {
    world.setOwner(to, OWNER_NONE);
    world.setTroops(to, 0);

    launch(200, 0);
    run(2);

    expect(world.getOwner(to)).toBe(attacker.slot);
    expect(world.troops[to]).toBeGreaterThan(0);
    expect(combat.activeArmies).toBe(0);
  });

  it('clears the contested flag once resolved', () => {
    world.setOwner(to, OWNER_NONE);
    world.setTroops(to, 0);

    launch(200, 0);
    run(2);

    expect(world.contested[to]).toBe(0);
  });

  it('resolves a defended assault over several ticks, not instantly', () => {
    const defender = players.add('b', 'Defender', false, 0);
    if (!defender) throw new Error('could not seat');
    world.setOwner(to, defender.slot);
    world.setTroops(to, 300);

    launch(400, 0);
    combat.update(makeContext(bus, 0, 0), 100);
    bus.flush();

    // A battle that ended in one tick would be invisible and would deny
    // reinforcement any chance to matter.
    expect(combat.activeArmies).toBe(1);
    expect(world.getOwner(to)).toBe(defender.slot);
  });

  it('lets an overwhelming attacker eventually capture', () => {
    const defender = players.add('b', 'Defender', false, 0);
    if (!defender) throw new Error('could not seat');
    world.setOwner(to, defender.slot);
    world.setTroops(to, 50);

    launch(5000, 0);
    run(200);

    expect(world.getOwner(to)).toBe(attacker.slot);
  });

  it('repels an outmatched attacker without transferring ownership', () => {
    const defender = players.add('b', 'Defender', false, 0);
    if (!defender) throw new Error('could not seat');
    world.setOwner(to, defender.slot);
    world.setTroops(to, 100_000);

    launch(50, 0);
    run(200);

    expect(world.getOwner(to)).toBe(defender.slot);
    expect(combat.activeArmies).toBe(0);
  });

  it('reinforces instead of attacking when the target became friendly', () => {
    // The target can change hands while an army is in transit; landing on your
    // own territory must not start a battle against yourself.
    world.setOwner(to, OWNER_NONE);
    world.setTroops(to, 0);
    launch(200, 500);

    world.setOwner(to, attacker.slot);
    world.setTroops(to, 100);

    run(10);

    expect(world.getOwner(to)).toBe(attacker.slot);
    expect(world.troops[to]).toBeGreaterThan(100);
    expect(combat.activeArmies).toBe(0);
  });

  it('emits a capture event', () => {
    let captured: { territory: number; newOwner: number } | null = null;
    bus.on('territory:captured', (event) => {
      captured = event;
    });

    world.setOwner(to, OWNER_NONE);
    world.setTroops(to, 0);
    launch(200, 0);
    run(2);

    expect(captured).not.toBeNull();
    expect(captured!.territory).toBe(to);
    expect(captured!.newOwner).toBe(attacker.slot);
  });

  it('credits statistics on capture', () => {
    const defender = players.add('b', 'Defender', false, 0);
    if (!defender) throw new Error('could not seat');
    world.setOwner(to, defender.slot);
    world.setTroops(to, 1);

    launch(5000, 0);
    run(100);

    expect(attacker.territoriesCaptured).toBe(1);
    expect(defender.territoriesLost).toBe(1);
  });

  it('produces identical outcomes for identical seeds', () => {
    // Combat draws from the simulation RNG, so a replay must reproduce it.
    const play = (seed: number): number => {
      const localWorld = new WorldState(geometry);
      const localBus = new EventBus();
      const localPlayers = new PlayerRegistry(8);
      const localCombat = new CombatSystem(localWorld, reader, localPlayers);
      localCombat.init(makeContext(localBus));

      const a = localPlayers.add('a', 'A', false, 0)!;
      const d = localPlayers.add('b', 'B', false, 0)!;
      localWorld.setOwner(from, a.slot);
      localWorld.setOwner(to, d.slot);
      localWorld.setTroops(to, 300);

      localBus.emit('combat:attack-launched', {
        from,
        to,
        attackerSlot: a.slot,
        troops: 400,
        arrivesAt: 0,
      });
      localBus.flush();

      for (let i = 0; i < 50; i++) {
        localCombat.update(makeContext(localBus, i * 100, i, seed), 100);
        localBus.flush();
      }
      return localWorld.troops[to] as number;
    };

    expect(play(99)).toBe(play(99));
  });

  it('reports armies in flight per slot', () => {
    launch(100, 9999);
    expect(combat.armiesOwnedBy(attacker.slot)).toBe(1);
    expect(combat.armiesOwnedBy(attacker.slot + 1)).toBe(0);
  });

  it('discards a slot’s armies on release', () => {
    launch(100, 9999);
    combat.releaseSlot(attacker.slot);
    expect(combat.activeArmies).toBe(0);
    expect(world.contested[to]).toBe(0);
  });
});

describe('VictorySystem', () => {
  let world: WorldState;
  let reader: WorldReader;
  let bus: EventBus;
  let players: PlayerRegistry;

  beforeEach(() => {
    world = new WorldState(geometry);
    reader = new WorldReader(geometry);
    bus = new EventBus();
    players = new PlayerRegistry(8);
  });

  it('eliminates a player with no land and no armies', () => {
    const doomed = players.add('a', 'A', false, 0)!;
    players.add('b', 'B', false, 0);

    const system = new VictorySystem(
      world,
      reader,
      players,
      () => 0,
      () => {},
    );
    system.update(makeContext(bus));
    bus.flush();

    expect(doomed.status).toBe(PlayerStatus.Eliminated);
  });

  it('spares a landless player whose army is still in flight', () => {
    // Without this, committing your last garrison to an attack would eliminate
    // you in the tick before it lands.
    const attacking = players.add('a', 'A', false, 0)!;
    players.add('b', 'B', false, 0);

    const system = new VictorySystem(
      world,
      reader,
      players,
      () => 1,
      () => {},
    );
    system.update(makeContext(bus));
    bus.flush();

    expect(attacking.status).toBe(PlayerStatus.Active);
  });

  it('declares a winner when only one player holds land', () => {
    const winner = players.add('a', 'A', false, 0)!;
    players.add('b', 'B', false, 0);

    const land = firstLand(reader);
    world.setOwner(land, winner.slot);

    let declared: number | null = -1;
    const system = new VictorySystem(
      world,
      reader,
      players,
      () => 0,
      (slot) => {
        declared = slot;
      },
    );
    system.update(makeContext(bus));

    expect(declared).toBe(winner.slot);
  });

  it('does not declare a solo player the winner', () => {
    const solo = players.add('a', 'A', false, 0)!;
    world.setOwner(firstLand(reader), solo.slot);

    let declared = false;
    const system = new VictorySystem(
      world,
      reader,
      players,
      () => 0,
      () => {
        declared = true;
      },
    );
    system.update(makeContext(bus));

    expect(declared).toBe(false);
  });

  it('declares domination at a supermajority of land', () => {
    const dominator = players.add('a', 'A', false, 0)!;
    players.add('b', 'B', false, 0);

    let held = 0;
    const target = Math.ceil(reader.countLandTerritories() * 0.8);
    for (let id = 0; id < world.territoryCount && held < target; id++) {
      if (!reader.isLand(id)) continue;
      world.setOwner(id, dominator.slot);
      held++;
    }
    // Give the opponent one tile so the last-player-standing rule is not what fires.
    for (let id = world.territoryCount - 1; id >= 0; id--) {
      if (reader.isLand(id) && world.getOwner(id) === dominator.slot) {
        world.setOwner(id, 1);
        break;
      }
    }

    let declared: number | null = -1;
    const system = new VictorySystem(
      world,
      reader,
      players,
      () => 0,
      (slot) => {
        declared = slot;
      },
    );
    system.update(makeContext(bus));

    expect(declared).toBe(dominator.slot);
  });
});

describe('anti-snowball balance', () => {
  it('caps an empire’s army sublinearly in territory count', () => {
    // The single most important balance property: doubling territory must NOT
    // double the army ceiling, or conquest compounds without limit and the
    // match is decided minutes after first contact.
    const measure = (territoryCount: number): number => {
      const world = new WorldState(geometry);
      const system = new PopulationSystem(world, reader());
      const bus = new EventBus();

      let granted = 0;
      for (let id = 0; id < world.territoryCount && granted < territoryCount; id++) {
        if (!reader().isLand(id)) continue;
        world.setOwner(id, 0);
        world.setPopulation(id, 100_000);
        granted++;
      }

      // Run long enough to saturate against the cap.
      for (let i = 0; i < 600; i++) system.update(makeContext(bus), 1000);
      return world.totalsForSlot(0).troops;
    };

    const small = measure(10);
    const large = measure(40);

    // 4x the land must yield clearly less than 4x the army.
    expect(large).toBeGreaterThan(small);
    expect(large / small).toBeLessThan(3);
    // ...but conquest must still be worth something.
    expect(large / small).toBeGreaterThan(1.3);
  });
});

describe('border width', () => {
  it('resolves an encirclement faster than a single-front assault', () => {
    // Makes the *shape* of a border matter: without this, adjacency is a
    // boolean and a chokepoint defends no better than open ground.
    const attackFrom = (surround: boolean): number => {
      const world = new WorldState(geometry);
      const bus = new EventBus();
      const players = new PlayerRegistry(8);
      const combat = new CombatSystem(world, reader(), players);
      combat.init(makeContext(bus));

      const attacker = players.add('a', 'A', false, 0)!;
      const defender = players.add('b', 'B', false, 0)!;

      // Choose a target with several land neighbours.
      let target = -1;
      for (let id = 0; id < world.territoryCount; id++) {
        if (!reader().isLand(id)) continue;
        let landNeighbours = 0;
        const degree = reader().getNeighbourCount(id);
        for (let k = 0; k < degree; k++) {
          if (reader().isLand(reader().getNeighbourAt(id, k))) landNeighbours++;
        }
        if (landNeighbours >= 4) {
          target = id;
          break;
        }
      }
      expect(target).toBeGreaterThanOrEqual(0);

      const degree = reader().getNeighbourCount(target);
      const neighbours: number[] = [];
      for (let k = 0; k < degree; k++) {
        const n = reader().getNeighbourAt(target, k);
        if (reader().isLand(n)) neighbours.push(n);
      }

      // Either hold one bordering territory, or all of them.
      const held = surround ? neighbours : [neighbours[0] as number];
      for (const id of held) world.setOwner(id, attacker.slot);

      world.setOwner(target, defender.slot);
      world.setTroops(target, 2000);

      bus.emit('combat:attack-launched', {
        from: held[0] as number,
        to: target,
        attackerSlot: attacker.slot,
        troops: 1500,
        arrivesAt: 0,
      });
      bus.flush();

      for (let i = 0; i < 20; i++) {
        combat.update(makeContext(bus, i * 100, i), 100);
        bus.flush();
      }
      return world.troops[target] as number;
    };

    const narrow = attackFrom(false);
    const wide = attackFrom(true);

    // Surrounding the target must grind its garrison down faster.
    expect(wide).toBeLessThan(narrow);
  });
});
