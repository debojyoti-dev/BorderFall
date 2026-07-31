import {
  BUILDING_SPECS,
  BuildingType,
  POPULATION,
  TERRAIN_MODIFIERS,
  type Terrain,
} from '@borderfall/shared';
import type { WorldState } from '../engine/WorldState.js';
import type { WorldReader } from '@borderfall/shared';

/**
 * Per-territory derived values: capacity, growth, income, defence.
 *
 * Centralised here rather than duplicated across the population, economy and
 * combat systems. All three need "what does terrain plus the building on this
 * tile do to X", and three independent implementations would drift — the
 * classic symptom being a territory that produces income as though it had a
 * city but grows as though it did not.
 *
 * Every function is a pure read of world state, so it can be called from any
 * system at any point in the tick without ordering hazards.
 */

/** Effects contributed by the operational building on a territory, if any. */
function buildingEffects(state: WorldState, id: number) {
  const type = state.building[id] as BuildingType;
  if (type === BuildingType.None) return null;

  // Construction is quantised 0-255; a building only contributes once finished.
  if ((state.construction[id] as number) < 255) return null;

  const spec = BUILDING_SPECS[type];
  const level = state.buildingLevel[id] as number;
  // Levels are 1-based in the spec table, 0 means "not built".
  return spec.levels[level - 1]?.effects ?? null;
}

/**
 * Maximum population a territory supports.
 *
 * Terrain sets the baseline; cities raise it. Water is zero, which is what
 * keeps the growth system from having to special-case oceans.
 */
export function populationCapacity(state: WorldState, reader: WorldReader, id: number): number {
  const terrain = reader.getTerrain(id) as Terrain;
  const base = POPULATION.baseCapacity * TERRAIN_MODIFIERS[terrain].capacityMultiplier;
  const effects = buildingEffects(state, id);
  return base + (effects?.populationCapBonus ?? 0);
}

/** Logistic growth rate multiplier for a territory. */
export function growthRate(state: WorldState, reader: WorldReader, id: number): number {
  const terrain = reader.getTerrain(id) as Terrain;
  const base = POPULATION.baseGrowthRate * TERRAIN_MODIFIERS[terrain].growthMultiplier;
  const effects = buildingEffects(state, id);
  return base * (1 + (effects?.growthBonus ?? 0));
}

/** Gold income multiplier for a territory. */
export function incomeMultiplier(state: WorldState, reader: WorldReader, id: number): number {
  const terrain = reader.getTerrain(id) as Terrain;
  const base = TERRAIN_MODIFIERS[terrain].incomeMultiplier;
  const effects = buildingEffects(state, id);
  return base * (1 + (effects?.incomeBonus ?? 0));
}

/**
 * Defence multiplier applied to a territory's garrison.
 *
 * Combines terrain, the universal defender's advantage, and any fort bonus.
 * Multiplicative composition is what lets terrain and buildings be tuned
 * independently — a fort is always "+50 %" regardless of what it sits on.
 */
export function defenceMultiplier(state: WorldState, reader: WorldReader, id: number): number {
  const terrain = reader.getTerrain(id) as Terrain;
  const effects = buildingEffects(state, id);
  return TERRAIN_MODIFIERS[terrain].defenceMultiplier * (1 + (effects?.defenceBonus ?? 0));
}

/** Troop production multiplier, raised by factories. */
export function troopProductionMultiplier(state: WorldState, id: number): number {
  const effects = buildingEffects(state, id);
  return 1 + (effects?.troopProductionBonus ?? 0);
}

/** Traversal cost into a territory, driving how long an army spends in transit. */
export function traversalCost(reader: WorldReader, id: number): number {
  const terrain = reader.getTerrain(id) as Terrain;
  return TERRAIN_MODIFIERS[terrain].traversalCostMultiplier;
}
