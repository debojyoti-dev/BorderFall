import {
  BUILDING_SPECS,
  BuildingType,
  ECONOMY,
  OWNER_NONE,
  POPULATION,
  type WorldReader,
} from '@borderfall/shared';
import { BaseSystem, SystemOrder, type SystemContext } from '../engine/System.js';
import type { WorldState } from '../engine/WorldState.js';
import type { PlayerRegistry } from '../match/PlayerRegistry.js';
import { incomeMultiplier } from './modifiers.js';

/**
 * Gold and food: income, upkeep, and the consequences of running out.
 *
 * Runs immediately after population so it reads the figures produced this
 * tick — income lagging growth by a second would be invisible to players but
 * would make the two systems' numbers disagree in tests and in the HUD.
 *
 * ## Why two resources
 *
 * Gold is the *spending* currency: buildings, ships, missiles. Food is the
 * *sustaining* one: armies consume it every tick. Splitting them means an army
 * has an ongoing cost rather than only a purchase price, so stockpiling troops
 * is a decision with a downside instead of a free option. A single currency
 * collapses that into "save up and win".
 */
export class EconomySystem extends BaseSystem {
  readonly name = 'economy';
  readonly intervalMs = 1000;
  readonly order = SystemOrder.Economy;

  /** Reused per tick so the sweep allocates nothing. */
  private readonly goldBySlot: Float64Array;
  private readonly foodBySlot: Float64Array;
  private readonly troopsBySlot: Float64Array;
  private readonly upkeepBySlot: Float64Array;

  constructor(
    private readonly state: WorldState,
    private readonly reader: WorldReader,
    private readonly players: PlayerRegistry,
    maxSlots = 256,
  ) {
    super();
    this.goldBySlot = new Float64Array(maxSlots);
    this.foodBySlot = new Float64Array(maxSlots);
    this.troopsBySlot = new Float64Array(maxSlots);
    this.upkeepBySlot = new Float64Array(maxSlots);
  }

  update(context: SystemContext, deltaMs: number): void {
    const seconds = deltaMs / 1000;
    const world = this.state;

    this.goldBySlot.fill(0);
    this.foodBySlot.fill(0);
    this.troopsBySlot.fill(0);
    this.upkeepBySlot.fill(0);

    /**
     * One sweep of the world accumulating into per-slot buckets.
     *
     * The alternative — iterating players and scanning the world for each —
     * is O(players × territories), which at 200 players and 5 000 territories
     * is a million operations per second. This is O(territories).
     */
    for (let id = 0; id < world.territoryCount; id++) {
      const slot = world.owner[id] as number;
      if (slot === OWNER_NONE || slot >= this.goldBySlot.length) continue;

      const population = world.population[id] as number;
      const perThousand = population / 1000;

      this.goldBySlot[slot]! +=
        (perThousand * ECONOMY.goldPerThousandPopulation + ECONOMY.goldPerTerritory) *
        incomeMultiplier(world, this.reader, id);

      this.foodBySlot[slot]! += perThousand * ECONOMY.foodPerThousandPopulation;
      this.troopsBySlot[slot]! += world.troops[id] as number;

      // Buildings cost gold to operate, which is what stops a player carpeting
      // the map with forts they can never sustain.
      const building = world.building[id] as BuildingType;
      if (building !== BuildingType.None && (world.construction[id] as number) >= 255) {
        this.upkeepBySlot[slot]! += BUILDING_SPECS[building].upkeep;
      }
    }

    for (const player of this.players.activePlayers()) {
      const slot = player.slot;
      if (slot >= this.goldBySlot.length) continue;

      const income = (this.goldBySlot[slot] as number) - (this.upkeepBySlot[slot] as number);
      player.gold = clamp(player.gold + income * seconds, 0, ECONOMY.maxGold);

      const troops = this.troopsBySlot[slot] as number;
      const foodUpkeep = troops * POPULATION.troopFoodUpkeep;
      const netFood = (this.foodBySlot[slot] as number) - foodUpkeep;

      player.food = clamp(player.food + netFood * seconds, 0, ECONOMY.maxFood);

      /**
       * Starvation.
       *
       * At zero food with a net deficit the army begins to disband. Making
       * over-extension self-correcting is what keeps the food economy
       * meaningful — without it a player could simply ignore food and hold an
       * arbitrarily large army at no cost.
       */
      if (player.food <= 0 && netFood < 0) {
        this.starve(slot, context, seconds);
      }
    }
  }

  /** Disbands a fraction of a slot's troops, spread across their territories. */
  private starve(slot: number, context: SystemContext, seconds: number): void {
    const world = this.state;
    // 5 %/s: fast enough that the player feels it within a few seconds, slow
    // enough to recover from by taking food-producing land.
    const lossFraction = 0.05 * seconds;
    let disbanded = 0;

    for (let id = 0; id < world.territoryCount; id++) {
      if (world.owner[id] !== slot) continue;
      const troops = world.troops[id] as number;
      if (troops <= 0) continue;

      const loss = Math.max(1, Math.floor(troops * lossFraction));
      world.setTroops(id, Math.max(0, troops - loss));
      disbanded += loss;
    }

    if (disbanded > 0) {
      context.bus.emit('economy:bankrupt', { slot, deficit: disbanded });
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}
