import { BuildingType, MissileType, ShipType, Terrain } from '../enums/index.js';
import type { BuildingSpec, MissileSpec, ShipSpec, TerrainTable } from '../interfaces/specs.js';

/* -------------------------------------------------------------------------- */
/* Terrain                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Terrain shapes the strategic map: mountains are cheap to hold but poor to own,
 * plains are the opposite. Every value is a multiplier around a neutral 1.0 so
 * that the combat and economy systems can compose modifiers by multiplication
 * without special-casing terrain at all.
 */
export const TERRAIN_MODIFIERS: TerrainTable = Object.freeze({
  [Terrain.Ocean]: {
    defenceMultiplier: 1,
    growthMultiplier: 0,
    incomeMultiplier: 0,
    capacityMultiplier: 0,
    traversalCostMultiplier: 1,
  },
  [Terrain.Coast]: {
    defenceMultiplier: 1,
    growthMultiplier: 0,
    incomeMultiplier: 0,
    capacityMultiplier: 0,
    traversalCostMultiplier: 1,
  },
  [Terrain.Lake]: {
    defenceMultiplier: 1,
    growthMultiplier: 0,
    incomeMultiplier: 0,
    capacityMultiplier: 0,
    traversalCostMultiplier: 1,
  },
  [Terrain.Plains]: {
    defenceMultiplier: 1.0,
    growthMultiplier: 1.0,
    incomeMultiplier: 1.0,
    capacityMultiplier: 1.0,
    traversalCostMultiplier: 1.0,
  },
  [Terrain.Forest]: {
    defenceMultiplier: 1.25,
    growthMultiplier: 0.9,
    incomeMultiplier: 0.85,
    capacityMultiplier: 0.9,
    traversalCostMultiplier: 1.3,
  },
  [Terrain.Hills]: {
    defenceMultiplier: 1.5,
    growthMultiplier: 0.75,
    incomeMultiplier: 0.8,
    capacityMultiplier: 0.7,
    traversalCostMultiplier: 1.6,
  },
  [Terrain.Mountain]: {
    defenceMultiplier: 2.0,
    growthMultiplier: 0.35,
    incomeMultiplier: 0.5,
    capacityMultiplier: 0.35,
    traversalCostMultiplier: 2.5,
  },
  [Terrain.Desert]: {
    defenceMultiplier: 0.9,
    growthMultiplier: 0.5,
    incomeMultiplier: 0.7,
    capacityMultiplier: 0.5,
    traversalCostMultiplier: 1.2,
  },
  [Terrain.Tundra]: {
    defenceMultiplier: 1.1,
    growthMultiplier: 0.45,
    incomeMultiplier: 0.6,
    capacityMultiplier: 0.45,
    traversalCostMultiplier: 1.4,
  },
});

/* -------------------------------------------------------------------------- */
/* Population                                                                  */
/* -------------------------------------------------------------------------- */

export const POPULATION = {
  /** Population a freshly captured neutral territory retains, as a fraction. */
  captureRetentionRatio: 0.35,
  /** Base population capacity of an unimproved plains territory. */
  baseCapacity: 1000,
  /**
   * Logistic growth: `growth = rate * pop * (1 - pop / cap)`.
   * Logistic rather than linear because linear growth makes wide empires
   * unbeatable — the S-curve gives small players a catch-up window and gives
   * large players a reason to invest in cities instead of only in land.
   */
  baseGrowthRate: 0.04,
  /** Growth floor so a territory at zero population can still recover. */
  minGrowthPerTick: 0.5,
  /** Fraction of population convertible to troops per second when mobilising. */
  mobilisationRate: 0.05,
  /** Troops cost this much food per unit per economy tick. */
  troopFoodUpkeep: 0.002,
} as const;

/* -------------------------------------------------------------------------- */
/* Economy                                                                     */
/* -------------------------------------------------------------------------- */

export const ECONOMY = {
  /** Gold produced per 1000 population per economy tick on plains. */
  goldPerThousandPopulation: 1.2,
  /** Flat gold per owned territory per economy tick. */
  goldPerTerritory: 0.15,
  /** Food produced per 1000 population per economy tick. */
  foodPerThousandPopulation: 1.0,
  /** Starting resources for a new player. */
  startingGold: 250,
  startingFood: 250,
  /** Resource ceilings; excess is discarded to prevent infinite banking. */
  maxGold: 10_000_000,
  maxFood: 10_000_000,
  /** Income multiplier applied to a territory under naval blockade. */
  blockadePenalty: 0.5,
  /** Gold looted from the defender when a territory is captured, as a fraction. */
  captureLootRatio: 0.1,
} as const;

/* -------------------------------------------------------------------------- */
/* Combat                                                                      */
/* -------------------------------------------------------------------------- */

export const COMBAT = {
  /**
   * Lanchester-style attrition. Each combat tick both sides lose troops in
   * proportion to the opposing force, scaled by these coefficients. A square
   * law (rather than linear) rewards concentrating force, which is the core
   * strategic lever we want players to discover.
   */
  attackerAttritionCoefficient: 0.08,
  defenderAttritionCoefficient: 0.1,
  /** Flat defensive edge every territory receives simply for being defended. */
  baseDefenceBonus: 1.15,
  /** Random multiplier applied per resolution, uniform in [1-x, 1+x]. */
  randomVariance: 0.12,
  /** Probability per tick of a critical event swinging the exchange. */
  criticalChance: 0.02,
  /** Multiplier applied to the beneficiary's damage on a critical event. */
  criticalMultiplier: 2.5,
  /** Minimum troops that must remain in a territory after launching an attack. */
  garrisonMinimum: 1,
  /** Fraction of surviving attackers that occupy a captured territory. */
  occupationRatio: 0.9,
  /** Ms an army spends in transit per unit of traversal cost. */
  traversalMsPerCostUnit: 900,
  /** Cooldown before the same territory may launch another attack. */
  attackCooldownMs: 500,
} as const;

/* -------------------------------------------------------------------------- */
/* Buildings                                                                   */
/* -------------------------------------------------------------------------- */

const NO_EFFECTS = {
  populationCapBonus: 0,
  growthBonus: 0,
  incomeBonus: 0,
  defenceBonus: 0,
  troopProductionBonus: 0,
  visionRadius: 0,
  interceptChance: 0,
} as const;

const LAND: readonly Terrain[] = [
  Terrain.Plains,
  Terrain.Forest,
  Terrain.Hills,
  Terrain.Mountain,
  Terrain.Desert,
  Terrain.Tundra,
];

export const BUILDING_SPECS: Readonly<Record<BuildingType, BuildingSpec>> = Object.freeze({
  [BuildingType.None]: {
    type: BuildingType.None,
    name: 'None',
    allowedTerrain: [],
    requiresCoastalAccess: false,
    perPlayerLimit: 0,
    upkeep: 0,
    levels: [],
  },

  [BuildingType.City]: {
    type: BuildingType.City,
    name: 'City',
    allowedTerrain: LAND,
    requiresCoastalAccess: false,
    perPlayerLimit: Number.POSITIVE_INFINITY,
    upkeep: 0.5,
    levels: [
      {
        level: 1,
        cost: 200,
        constructionTimeMs: 8000,
        hp: 400,
        effects: { ...NO_EFFECTS, populationCapBonus: 1500, growthBonus: 0.3, incomeBonus: 0.25 },
      },
      {
        level: 2,
        cost: 500,
        constructionTimeMs: 14_000,
        hp: 750,
        effects: { ...NO_EFFECTS, populationCapBonus: 3500, growthBonus: 0.55, incomeBonus: 0.5 },
      },
      {
        level: 3,
        cost: 1200,
        constructionTimeMs: 24_000,
        hp: 1200,
        effects: { ...NO_EFFECTS, populationCapBonus: 7000, growthBonus: 0.85, incomeBonus: 0.9 },
      },
    ],
  },

  [BuildingType.Fort]: {
    type: BuildingType.Fort,
    name: 'Fort',
    allowedTerrain: LAND,
    requiresCoastalAccess: false,
    perPlayerLimit: Number.POSITIVE_INFINITY,
    upkeep: 0.8,
    levels: [
      {
        level: 1,
        cost: 300,
        constructionTimeMs: 10_000,
        hp: 900,
        effects: { ...NO_EFFECTS, defenceBonus: 0.5 },
      },
      {
        level: 2,
        cost: 700,
        constructionTimeMs: 18_000,
        hp: 1600,
        effects: { ...NO_EFFECTS, defenceBonus: 1.0 },
      },
      {
        level: 3,
        cost: 1500,
        constructionTimeMs: 30_000,
        hp: 2600,
        effects: { ...NO_EFFECTS, defenceBonus: 1.75 },
      },
    ],
  },

  [BuildingType.Port]: {
    type: BuildingType.Port,
    name: 'Port',
    allowedTerrain: LAND,
    requiresCoastalAccess: true,
    perPlayerLimit: Number.POSITIVE_INFINITY,
    upkeep: 0.6,
    levels: [
      {
        level: 1,
        cost: 350,
        constructionTimeMs: 12_000,
        hp: 500,
        effects: { ...NO_EFFECTS, incomeBonus: 0.2 },
      },
      {
        level: 2,
        cost: 800,
        constructionTimeMs: 20_000,
        hp: 900,
        effects: { ...NO_EFFECTS, incomeBonus: 0.4 },
      },
    ],
  },

  [BuildingType.MissileSilo]: {
    type: BuildingType.MissileSilo,
    name: 'Missile Silo',
    allowedTerrain: LAND,
    requiresCoastalAccess: false,
    perPlayerLimit: 12,
    upkeep: 2.0,
    levels: [
      { level: 1, cost: 1500, constructionTimeMs: 40_000, hp: 700, effects: { ...NO_EFFECTS } },
      { level: 2, cost: 3000, constructionTimeMs: 60_000, hp: 1200, effects: { ...NO_EFFECTS } },
    ],
  },

  [BuildingType.Factory]: {
    type: BuildingType.Factory,
    name: 'Factory',
    allowedTerrain: LAND,
    requiresCoastalAccess: false,
    perPlayerLimit: Number.POSITIVE_INFINITY,
    upkeep: 1.0,
    levels: [
      {
        level: 1,
        cost: 400,
        constructionTimeMs: 14_000,
        hp: 550,
        effects: { ...NO_EFFECTS, troopProductionBonus: 0.35 },
      },
      {
        level: 2,
        cost: 950,
        constructionTimeMs: 22_000,
        hp: 1000,
        effects: { ...NO_EFFECTS, troopProductionBonus: 0.7 },
      },
    ],
  },

  [BuildingType.Airport]: {
    type: BuildingType.Airport,
    name: 'Airport',
    allowedTerrain: LAND,
    requiresCoastalAccess: false,
    perPlayerLimit: 8,
    upkeep: 1.5,
    levels: [
      {
        level: 1,
        cost: 900,
        constructionTimeMs: 28_000,
        hp: 600,
        effects: { ...NO_EFFECTS, visionRadius: 400 },
      },
    ],
  },

  [BuildingType.Radar]: {
    type: BuildingType.Radar,
    name: 'Radar',
    allowedTerrain: LAND,
    requiresCoastalAccess: false,
    perPlayerLimit: 16,
    upkeep: 0.7,
    levels: [
      {
        level: 1,
        cost: 450,
        constructionTimeMs: 12_000,
        hp: 350,
        effects: { ...NO_EFFECTS, visionRadius: 900 },
      },
      {
        level: 2,
        cost: 1000,
        constructionTimeMs: 20_000,
        hp: 600,
        effects: { ...NO_EFFECTS, visionRadius: 1600 },
      },
    ],
  },

  [BuildingType.AntiAir]: {
    type: BuildingType.AntiAir,
    name: 'Anti-Air',
    allowedTerrain: LAND,
    requiresCoastalAccess: false,
    perPlayerLimit: 24,
    upkeep: 1.2,
    levels: [
      {
        level: 1,
        cost: 700,
        constructionTimeMs: 18_000,
        hp: 450,
        effects: { ...NO_EFFECTS, visionRadius: 500, interceptChance: 0.25 },
      },
      {
        level: 2,
        cost: 1600,
        constructionTimeMs: 30_000,
        hp: 800,
        effects: { ...NO_EFFECTS, visionRadius: 700, interceptChance: 0.45 },
      },
    ],
  },
});

/* -------------------------------------------------------------------------- */
/* Ships                                                                       */
/* -------------------------------------------------------------------------- */

export const SHIP_SPECS: Readonly<Record<ShipType, ShipSpec>> = Object.freeze({
  [ShipType.Transport]: {
    type: ShipType.Transport,
    name: 'Transport',
    goldCost: 150,
    buildTimeMs: 6000,
    hp: 200,
    attack: 2,
    armour: 0,
    speed: 90,
    range: 40,
    troopCapacity: 500,
    stealth: false,
    canBombard: false,
  },
  [ShipType.Destroyer]: {
    type: ShipType.Destroyer,
    name: 'Destroyer',
    goldCost: 300,
    buildTimeMs: 9000,
    hp: 350,
    attack: 28,
    armour: 0.1,
    speed: 130,
    range: 160,
    troopCapacity: 0,
    stealth: false,
    canBombard: false,
  },
  [ShipType.Battleship]: {
    type: ShipType.Battleship,
    name: 'Battleship',
    goldCost: 900,
    buildTimeMs: 22_000,
    hp: 1100,
    attack: 70,
    armour: 0.3,
    speed: 70,
    range: 260,
    troopCapacity: 0,
    stealth: false,
    canBombard: true,
  },
  [ShipType.Submarine]: {
    type: ShipType.Submarine,
    name: 'Submarine',
    goldCost: 550,
    buildTimeMs: 16_000,
    hp: 280,
    attack: 60,
    armour: 0.05,
    speed: 85,
    range: 130,
    troopCapacity: 0,
    stealth: true,
    canBombard: false,
  },
  [ShipType.Blockader]: {
    type: ShipType.Blockader,
    name: 'Blockade Runner',
    goldCost: 400,
    buildTimeMs: 12_000,
    hp: 450,
    attack: 12,
    armour: 0.2,
    speed: 75,
    range: 90,
    troopCapacity: 0,
    stealth: false,
    canBombard: false,
  },
});

/* -------------------------------------------------------------------------- */
/* Missiles                                                                    */
/* -------------------------------------------------------------------------- */

export const MISSILE_SPECS: Readonly<Record<MissileType, MissileSpec>> = Object.freeze({
  [MissileType.Cruise]: {
    type: MissileType.Cruise,
    name: 'Cruise Missile',
    goldCost: 600,
    buildTimeMs: 15_000,
    speed: 700,
    range: 1800,
    blastRadius: 90,
    populationKillRatio: 0.3,
    troopKillRatio: 0.45,
    structureDamage: 400,
    cooldownMs: 30_000,
    baseInterceptChance: 0.35,
    warheads: 1,
    globallyVisible: false,
  },
  [MissileType.Atomic]: {
    type: MissileType.Atomic,
    name: 'Atomic Bomb',
    goldCost: 2500,
    buildTimeMs: 60_000,
    speed: 420,
    range: 4000,
    blastRadius: 320,
    populationKillRatio: 0.8,
    troopKillRatio: 0.85,
    structureDamage: 2000,
    cooldownMs: 120_000,
    baseInterceptChance: 0.25,
    warheads: 1,
    globallyVisible: true,
  },
  [MissileType.Hydrogen]: {
    type: MissileType.Hydrogen,
    name: 'Hydrogen Bomb',
    goldCost: 6000,
    buildTimeMs: 150_000,
    speed: 300,
    range: Number.POSITIVE_INFINITY,
    blastRadius: 700,
    populationKillRatio: 0.95,
    troopKillRatio: 0.97,
    structureDamage: 6000,
    cooldownMs: 300_000,
    baseInterceptChance: 0.4,
    warheads: 1,
    globallyVisible: true,
  },
  [MissileType.Mirv]: {
    type: MissileType.Mirv,
    name: 'MIRV',
    goldCost: 12_000,
    buildTimeMs: 240_000,
    speed: 380,
    range: Number.POSITIVE_INFINITY,
    blastRadius: 260,
    populationKillRatio: 0.85,
    troopKillRatio: 0.9,
    structureDamage: 2500,
    cooldownMs: 420_000,
    baseInterceptChance: 0.15,
    warheads: 5,
    globallyVisible: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Diplomacy & trade                                                           */
/* -------------------------------------------------------------------------- */

export const DIPLOMACY = {
  /** An alliance request expires after this long without an answer. */
  requestTimeoutMs: 60_000,
  /** After breaking an alliance, attacks on the former ally are blocked. */
  betrayalCooldownMs: 20_000,
  /** Minimum time an alliance must hold before it can be dissolved. */
  minimumAllianceDurationMs: 30_000,
  /** Cooldown between resource transfers to the same recipient. */
  tradeCooldownMs: 15_000,
  /** Maximum gold transferable in a single trade. */
  maxTradeGold: 50_000,
  /** Interest applied to a loan on repayment, as a fraction. */
  loanInterest: 0.15,
  /** Loan repayment window before automatic collection. */
  loanTermMs: 300_000,
} as const;
