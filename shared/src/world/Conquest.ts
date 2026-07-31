import type { Rng } from '../utils/prng.js';
import { TILE_OWNER_NONE, type TileRef } from './TileMap.js';
import { TileHeap } from './TileHeap.js';
import type { TileWorld } from './TileWorld.js';

/**
 * Territorial conquest as a priority-driven flood fill.
 *
 * ## Why a flood fill rather than a transfer
 *
 * In the region model an attack moved an army from A to B and B changed colour
 * at once. On a tile grid an attack is a *front* that advances: each tick a
 * budget of tiles is taken from the cheapest available frontier, and every tile
 * taken exposes its neighbours as new frontier. The result is a border that
 * spreads like ink rather than regions that blink — which is the entire visual
 * identity of the genre, and it falls directly out of this loop.
 *
 * ## The priority function
 *
 * Every candidate tile gets a cost, and the heap always yields the cheapest.
 * Three terms, each doing a specific job:
 *
 * - **`tickNow`** dominates the ordering, so tiles queued earlier are taken
 *   earlier. Without it the fill would scatter across the whole frontier at
 *   once and look like static rather than an advancing wave.
 * - **Exposure** discounts tiles the attacker already surrounds. Pockets
 *   collapse inward and encirclement resolves quickly, both of which emerge
 *   rather than being special-cased.
 * - **Terrain** charges more for high ground, so a mountain range genuinely
 *   slows an advance and becomes a natural border.
 *
 * A small jitter breaks ties, so fronts have a ragged organic edge instead of
 * advancing as a perfectly straight line.
 */

export const CONQUEST = {
  /** Base cost of taking any tile, before modifiers. */
  baseTileCost: 10,
  /** Random spread added to the base cost, in `[0, jitter)`. */
  jitter: 7,
  /** How much each surrounding owned neighbour discounts a tile, per side. */
  exposureDiscount: 0.125,
  /** How much terrain cost inflates the tile price. */
  terrainWeight: 0.5,

  /**
   * Tiles taken per second at parity.
   *
   * Scaled by the force ratio and by frontier width, so this is the rate for
   * an evenly matched attack across a single tile of border.
   */
  baseTilesPerSecond: 6,
  /** Clamp on the force-ratio multiplier, so neither side is ever helpless. */
  minRatioMultiplier: 0.05,
  maxRatioMultiplier: 6,

  /** Troops lost by the attacker per tile taken from a defended player. */
  attackerLossPerTile: 0.9,
  /** Troops lost by the defender per tile lost. */
  defenderLossPerTile: 1.1,
  /** Multiplier on troop cost when taking unowned land. Expansion is cheap. */
  neutralCostMultiplier: 0.25,
} as const;

export interface AttackOptions {
  readonly attacker: number;
  /** Defending slot, or {@link TILE_OWNER_NONE} for unclaimed land. */
  readonly target: number;
  /** Troops committed. Deducted from the attacker's pool by the caller. */
  readonly troops: number;
}

/**
 * One in-progress attack.
 *
 * Holds its own frontier heap and visited set. An attack is a long-lived
 * object — it may run for many seconds — so it is created once and stepped,
 * rather than recomputed each tick.
 */
export class Attack {
  readonly attacker: number;
  readonly target: number;
  troops: number;

  private readonly frontier = new TileHeap(2048);
  /**
   * Tiles already queued.
   *
   * A tile is reachable from several directions, and without this it would be
   * pushed once per adjacent conquered tile — the heap would grow without
   * bound and the same tile would be conquered repeatedly.
   */
  private readonly queued = new Set<TileRef>();

  /** Tiles taken, for reporting and statistics. */
  tilesTaken = 0;
  private finished = false;

  constructor(options: AttackOptions) {
    this.attacker = options.attacker;
    this.target = options.target;
    this.troops = options.troops;
  }

  get isFinished(): boolean {
    return this.finished || this.troops <= 0;
  }

  get frontierSize(): number {
    return this.frontier.length;
  }

  /**
   * Seeds the frontier from the attacker's border tiles that touch the target.
   *
   * Called once at launch. If the attacker shares no border with the target the
   * attack is finished immediately — the command was legal when issued but the
   * situation changed, which is common when several attacks race.
   */
  begin(world: TileWorld, rng: Rng, tickNow: number): void {
    const scratch: TileRef[] = [];
    world.frontierAgainst(this.attacker, this.target, scratch);

    for (const border of scratch) {
      world.map.forEachNeighbour(border, (neighbour) => {
        if (world.map.ownerOf(neighbour) !== this.target) return;
        this.enqueue(world, rng, neighbour, tickNow);
      });
    }

    if (this.frontier.isEmpty) this.finished = true;
  }

  private enqueue(world: TileWorld, rng: Rng, ref: TileRef, tickNow: number): void {
    if (this.queued.has(ref)) return;
    // Water is not conquerable by land; boats handle amphibious assault.
    if (world.map.isWater(ref)) return;
    if (world.map.ownerOf(ref) !== this.target) return;

    this.queued.add(ref);

    const exposure = world.map.neighboursOwnedBy(ref, this.attacker) * CONQUEST.exposureDiscount;
    const terrain = world.map.terrainCost(ref) * CONQUEST.terrainWeight;
    const jitter = rng.nextInt(0, CONQUEST.jitter);

    const cost = (CONQUEST.baseTileCost + jitter) * (1 + terrain) * (1 - exposure);
    this.frontier.push(ref, tickNow + cost);
  }

  /**
   * Advances the front by one tick.
   *
   * `defenderTroops` is the defending player's *whole* pool, not a local
   * garrison — so a defender under pressure elsewhere genuinely weakens here,
   * and committing everything to one front leaves the rest soft.
   */
  step(
    world: TileWorld,
    rng: Rng,
    tickNow: number,
    deltaSeconds: number,
    defenderTroops: number,
  ): number {
    if (this.isFinished) return 0;

    const budget = this.tileBudget(deltaSeconds, defenderTroops);
    const isNeutral = this.target === TILE_OWNER_NONE;
    const costPerTile = isNeutral
      ? CONQUEST.attackerLossPerTile * CONQUEST.neutralCostMultiplier
      : CONQUEST.attackerLossPerTile;

    let taken = 0;
    while (taken < budget) {
      const ref = this.frontier.pop();
      if (ref < 0) {
        // Front exhausted: nothing adjacent left to take.
        this.finished = true;
        break;
      }

      // Ownership can change under us — another attacker may have taken this
      // tile while it sat in the heap.
      if (world.map.ownerOf(ref) !== this.target) continue;

      if (this.troops < costPerTile) {
        this.troops = 0;
        this.finished = true;
        break;
      }

      world.setOwner(ref, this.attacker);
      this.troops -= costPerTile;
      this.tilesTaken++;
      taken++;

      // Every tile taken exposes its neighbours as new frontier. This is what
      // makes the advance a spreading wave rather than a single step.
      world.map.forEachNeighbour(ref, (neighbour) => {
        this.enqueue(world, rng, neighbour, tickNow);
      });
    }

    return taken;
  }

  /**
   * How many tiles this attack may take this tick.
   *
   * Scales with the force ratio and with how wide the front is. A wide front
   * advances faster than a narrow one, which is what makes border *shape* a
   * strategic object: chokepoints hold, salients are dangerous.
   */
  private tileBudget(deltaSeconds: number, defenderTroops: number): number {
    const ratio =
      this.target === TILE_OWNER_NONE
        ? CONQUEST.maxRatioMultiplier
        : clamp(
            this.troops / Math.max(1, defenderTroops),
            CONQUEST.minRatioMultiplier,
            CONQUEST.maxRatioMultiplier,
          );

    // Square root of the frontier: a front twice as wide advances faster, but
    // not twice as fast, or a large empire would consume a small one instantly
    // purely by virtue of having a long border.
    const width = Math.sqrt(Math.max(1, this.frontier.length));

    return Math.max(1, Math.floor(CONQUEST.baseTilesPerSecond * ratio * width * deltaSeconds));
  }

  /** Abandons the attack, e.g. on retreat or elimination. */
  cancel(): void {
    this.finished = true;
    this.frontier.clear();
    this.queued.clear();
  }
}

/** Troops the defender loses for a given number of tiles surrendered. */
export function defenderLosses(tilesLost: number): number {
  return tilesLost * CONQUEST.defenderLossPerTile;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
