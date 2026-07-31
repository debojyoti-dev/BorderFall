import { BuildingType, OWNER_NONE, POPULATION, type WorldReader } from '@borderfall/shared';
import { BaseSystem, SystemOrder, type SystemContext } from '../engine/System.js';
import type { WorldState } from '../engine/WorldState.js';
import { growthRate, populationCapacity, troopProductionMultiplier } from './modifiers.js';

/**
 * Population growth and troop production.
 *
 * ## Why logistic rather than linear growth
 *
 * Linear growth (`population += rate`) makes wide empires unbeatable: every
 * territory adds the same absolute output forever, so the leader's lead
 * compounds without limit and the match is decided in the first two minutes.
 *
 * Logistic growth — `Δ = rate · pop · (1 − pop / cap)` — is fast when a
 * territory is underpopulated and stalls as it fills. A small player recovers
 * quickly, and a large one must *invest* in cities to raise `cap` rather than
 * merely holding more dirt.
 *
 * ## Why there is also an empire-wide army ceiling
 *
 * The logistic curve limits each territory individually, but total capacity is
 * still linear in territory count — ten territories field ten times the army of
 * one. The empire cap is deliberately **sublinear** in territory count
 * (`territories^0.6`), so conquest has diminishing military returns. That is
 * the mechanism that keeps a losing player able to defend, and it is the reason
 * a runaway leader is not an inevitability of the rules.
 *
 * ## Why troops grow passively
 *
 * Troops accrue from population automatically rather than requiring a mobilise
 * click per territory. With hundreds of territories, manual mobilisation is not
 * strategy, it is data entry.
 */
export class PopulationSystem extends BaseSystem {
  readonly name = 'population';
  readonly intervalMs = 1000;
  readonly order = SystemOrder.Population;

  /** Reused per tick so the sweep allocates nothing. */
  private readonly troopsBySlot: Float64Array;
  private readonly territoriesBySlot: Uint32Array;
  private readonly cityLevelsBySlot: Uint32Array;

  constructor(
    private readonly state: WorldState,
    private readonly reader: WorldReader,
    maxSlots = 256,
  ) {
    super();
    this.troopsBySlot = new Float64Array(maxSlots);
    this.territoriesBySlot = new Uint32Array(maxSlots);
    this.cityLevelsBySlot = new Uint32Array(maxSlots);
  }

  update(_context: SystemContext, deltaMs: number): void {
    const seconds = deltaMs / 1000;
    const world = this.state;

    this.tallyEmpires();

    for (let id = 0; id < world.territoryCount; id++) {
      const slot = world.owner[id] as number;
      // Unowned land does not grow. Neutral territory that gained population
      // over time would hand a windfall to whoever happened to take it last.
      if (slot === OWNER_NONE) continue;

      const capacity = populationCapacity(world, this.reader, id);
      if (capacity <= 0) continue;

      const population = world.population[id] as number;

      /**
       * Growth floor.
       *
       * The logistic term is proportional to current population, so a
       * territory at zero can never recover — captured land would stay dead
       * forever. A small flat floor lets it restart.
       */
      const logistic =
        growthRate(world, this.reader, id) * population * (1 - population / capacity);
      const growth = Math.max(POPULATION.minGrowthPerTick, logistic) * seconds;

      const next = Math.min(capacity, population + growth);
      world.setPopulation(id, next);

      this.produceTroops(id, slot, next, seconds);
    }
  }

  /** One pass collecting per-empire totals used by the army ceiling. */
  private tallyEmpires(): void {
    this.troopsBySlot.fill(0);
    this.territoriesBySlot.fill(0);
    this.cityLevelsBySlot.fill(0);

    const world = this.state;
    for (let id = 0; id < world.territoryCount; id++) {
      const slot = world.owner[id] as number;
      if (slot === OWNER_NONE || slot >= this.troopsBySlot.length) continue;

      this.troopsBySlot[slot]! += world.troops[id] as number;
      this.territoriesBySlot[slot]!++;

      if (world.building[id] === BuildingType.City && (world.construction[id] as number) >= 255) {
        this.cityLevelsBySlot[slot]! += world.buildingLevel[id] as number;
      }
    }
  }

  /** Sublinear empire-wide army ceiling. See the class documentation. */
  private empireCap(slot: number): number {
    const territories = this.territoriesBySlot[slot] ?? 0;
    if (territories === 0) return 0;
    return (
      POPULATION.empireTroopBase * Math.pow(territories, POPULATION.empireTroopExponent) +
      (this.cityLevelsBySlot[slot] ?? 0) * POPULATION.empireTroopPerCityLevel
    );
  }

  /**
   * Converts population into troops, subject to both a local and an empire cap.
   *
   * The local cap stops one high-capacity city out-producing a continent; the
   * empire cap is what makes conquest yield diminishing military returns.
   */
  private produceTroops(id: number, slot: number, population: number, seconds: number): void {
    const world = this.state;
    const troops = world.troops[id] as number;

    const localCeiling = population * POPULATION.mobilisationRate * 10;
    if (troops >= localCeiling) return;

    if (slot < this.troopsBySlot.length) {
      const empireTotal = this.troopsBySlot[slot] as number;
      if (empireTotal >= this.empireCap(slot)) return;
    }

    const rate = POPULATION.mobilisationRate * troopProductionMultiplier(world, id);
    const produced = population * rate * seconds;

    world.setTroops(id, Math.min(localCeiling, troops + produced));
    if (slot < this.troopsBySlot.length) this.troopsBySlot[slot]! += produced;
  }
}
