import type { BuildingType, MissileType, ShipType, Terrain } from '../enums/index.js';

/**
 * Static, data-driven definitions for every buildable and buildable-adjacent
 * entity.
 *
 * Design note: all tuning lives in plain frozen data rather than in the systems
 * that consume it. A balance change is therefore a data edit — no simulation
 * code is touched, the change is trivially diffable, and the same table can be
 * loaded by a balancing spreadsheet, the client tooltip layer and the server
 * validator without divergence.
 */

/** Multiplicative and additive modifiers a territory can carry. */
export interface TerritoryModifiers {
  /** Multiplier on incoming attacker losses. >1 favours the defender. */
  readonly defenceMultiplier: number;
  /** Multiplier on population growth rate. */
  readonly growthMultiplier: number;
  /** Multiplier on gold income. */
  readonly incomeMultiplier: number;
  /** Multiplier on the territory's base population capacity. */
  readonly capacityMultiplier: number;
  /** Multiplier on the time an army takes to traverse into this territory. */
  readonly traversalCostMultiplier: number;
}

export type TerrainTable = Readonly<Record<Terrain, TerritoryModifiers>>;

/** Effects a building contributes to its host territory, per upgrade level. */
export interface BuildingLevelEffects {
  /** Flat addition to the territory population cap. */
  readonly populationCapBonus: number;
  /** Additive fraction applied to growth rate, e.g. 0.25 = +25 %. */
  readonly growthBonus: number;
  /** Additive fraction applied to gold income. */
  readonly incomeBonus: number;
  /** Additive fraction applied to the defence multiplier. */
  readonly defenceBonus: number;
  /** Additive fraction applied to troop production rate. */
  readonly troopProductionBonus: number;
  /** Vision radius contributed, in world units. 0 = none. */
  readonly visionRadius: number;
  /** Missile interception probability contributed within {@link visionRadius}. */
  readonly interceptChance: number;
}

export interface BuildingLevelSpec {
  readonly level: number;
  /** Gold cost to reach this level from the previous one. */
  readonly cost: number;
  /** Milliseconds of construction time to reach this level. */
  readonly constructionTimeMs: number;
  /** Structure hit points at this level. Destroyed buildings drop to level 0. */
  readonly hp: number;
  readonly effects: BuildingLevelEffects;
}

export interface BuildingSpec {
  readonly type: BuildingType;
  readonly name: string;
  /** Terrain the structure may be placed on. */
  readonly allowedTerrain: readonly Terrain[];
  /** If true, the host territory must border sea-connected water. */
  readonly requiresCoastalAccess: boolean;
  /** Maximum instances one player may own. `Infinity` for unlimited. */
  readonly perPlayerLimit: number;
  /** Ongoing gold cost per economy tick, charged while operational. */
  readonly upkeep: number;
  readonly levels: readonly BuildingLevelSpec[];
}

export interface ShipSpec {
  readonly type: ShipType;
  readonly name: string;
  readonly goldCost: number;
  readonly buildTimeMs: number;
  readonly hp: number;
  /** Damage dealt per combat tick to a single engaged target. */
  readonly attack: number;
  /** Fraction of incoming damage ignored, 0–1. */
  readonly armour: number;
  /** World units travelled per second. */
  readonly speed: number;
  /** Engagement radius in world units. */
  readonly range: number;
  /** Land troops carried. 0 for combat hulls. */
  readonly troopCapacity: number;
  /** Whether the hull is hidden from opponents without detection. */
  readonly stealth: boolean;
  /** Can strike land territories adjacent to its water tile. */
  readonly canBombard: boolean;
}

export interface MissileSpec {
  readonly type: MissileType;
  readonly name: string;
  readonly goldCost: number;
  /** Silo occupancy time before the weapon is available, in ms. */
  readonly buildTimeMs: number;
  /** World units per second. */
  readonly speed: number;
  /** Maximum launch distance in world units. `Infinity` for global reach. */
  readonly range: number;
  /** Blast radius in world units. */
  readonly blastRadius: number;
  /** Fraction of population destroyed at the blast epicentre, 0–1. */
  readonly populationKillRatio: number;
  /** Fraction of troops destroyed at the epicentre, 0–1. */
  readonly troopKillRatio: number;
  /** Damage applied to structures inside the blast. */
  readonly structureDamage: number;
  /** Per-silo cooldown after launch, in ms. */
  readonly cooldownMs: number;
  /** Base probability of interception by a single anti-air installation, 0–1. */
  readonly baseInterceptChance: number;
  /** Warhead count on terminal approach. >1 for MIRV. */
  readonly warheads: number;
  /** Whether the launch is visible to all players or only to those with radar. */
  readonly globallyVisible: boolean;
}
