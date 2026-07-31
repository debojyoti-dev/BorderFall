import { OWNER_NONE, POPULATION, type WorldReader } from '@borderfall/shared';
import { BaseSystem, SystemOrder, type SystemContext } from '../engine/System.js';
import type { WorldState } from '../engine/WorldState.js';
import { growthRate, populationCapacity, troopProductionMultiplier } from './modifiers.js';

/**
 * Population growth and passive troop production.
 *
 * ## Why logistic rather than linear growth
 *
 * Linear growth (`population += rate`) makes wide empires unbeatable: every
 * territory adds the same absolute output forever, so the leader's lead
 * compounds without limit and the match is decided in the first two minutes.
 *
 * Logistic growth — `Δ = rate · pop · (1 − pop / cap)` — is fast when a
 * territory is underpopulated and stalls as it fills. That produces the two
 * properties the game needs: a small player recovers quickly (catch-up), and a
 * large player must *invest* in cities to raise `cap` rather than merely
 * holding more dirt. It turns "build economy" into a real decision instead of
 * an automatic consequence of conquest.
 *
 * ## Why troops grow passively
 *
 * Troops accrue from population automatically rather than requiring a
 * mobilise click per territory. With hundreds of territories, manual
 * mobilisation is not strategy, it is data entry.
 */
export class PopulationSystem extends BaseSystem {
  readonly name = 'population';
  readonly intervalMs = 1000;
  readonly order = SystemOrder.Population;

  constructor(
    private readonly state: WorldState,
    private readonly reader: WorldReader,
  ) {
    super();
  }

  update(_context: SystemContext, deltaMs: number): void {
    const seconds = deltaMs / 1000;
    const world = this.state;

    for (let id = 0; id < world.territoryCount; id++) {
      // Unowned land does not grow. Neutral territory that gained population
      // over time would hand a windfall to whoever happened to take it last.
      if (world.owner[id] === OWNER_NONE) continue;

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

      this.produceTroops(id, next, seconds);
    }
  }

  /**
   * Converts population into troops.
   *
   * Capped as a fraction of population so a territory cannot field an army
   * larger than it could plausibly raise — without that, a single high-capacity
   * city would eventually out-produce an entire continent.
   */
  private produceTroops(id: number, population: number, seconds: number): void {
    const world = this.state;
    const troops = world.troops[id] as number;

    const ceiling = population * POPULATION.mobilisationRate * 10;
    if (troops >= ceiling) return;

    const rate = POPULATION.mobilisationRate * troopProductionMultiplier(world, id);
    const produced = population * rate * seconds;

    world.setTroops(id, Math.min(ceiling, troops + produced));
  }
}
