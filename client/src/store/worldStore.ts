import { create } from 'zustand';
import {
  BUILDING_NAMES,
  BuildingType,
  OWNER_NONE,
  TERRAIN_MODIFIERS,
  Terrain,
  createMapParams,
  generateWorld,
  type MapGenParams,
  type WorldGeometry,
} from '@borderfall/shared';

/**
 * World and selection state exposed to React.
 *
 * Follows the split described in the architecture document: this store holds
 * only what a *human reads* — which territory is selected, and the summary
 * shown in the inspector panel. The 5 000-entry owner and population arrays are
 * owned by the renderer and never enter React state, because pushing them
 * through a store would trigger a reconciliation pass per network tick.
 *
 * `geometry` is the one large object kept here, and it is safe because it is
 * immutable and set exactly once per match.
 */

export const TERRAIN_NAMES: Readonly<Record<number, string>> = {
  [Terrain.Ocean]: 'Ocean',
  [Terrain.Coast]: 'Coast',
  [Terrain.Lake]: 'Lake',
  [Terrain.Plains]: 'Plains',
  [Terrain.Forest]: 'Forest',
  [Terrain.Hills]: 'Hills',
  [Terrain.Mountain]: 'Mountain',
  [Terrain.Desert]: 'Desert',
  [Terrain.Tundra]: 'Tundra',
};

/** Everything the inspector panel needs about one territory. */
export interface TerritorySummary {
  id: number;
  terrain: Terrain;
  terrainName: string;
  neighbourCount: number;
  area: number;
  owner: number;
  population: number;
  troops: number;
  contested: boolean;
  building: BuildingType;
  buildingName: string;
  defenceMultiplier: number;
  incomeMultiplier: number;
  growthMultiplier: number;
}

/** Live per-territory values read out of the replicated arrays. */
export interface TerritoryLiveState {
  owner: number;
  population: number;
  troops: number;
  contested: boolean;
}

interface WorldState {
  geometry: WorldGeometry | null;
  params: MapGenParams | null;
  generating: boolean;
  generationMs: number;

  selected: TerritorySummary | null;
  hovered: number;

  generate: (seed: number, territoryCount?: number) => void;
  setSelected: (summary: TerritorySummary | null) => void;
  setHovered: (territoryId: number) => void;
}

export const useWorldStore = create<WorldState>((set) => ({
  geometry: null,
  params: null,
  generating: false,
  generationMs: 0,

  selected: null,
  hovered: -1,

  generate: (seed, territoryCount) => {
    set({ generating: true });

    const params = createMapParams(seed, territoryCount === undefined ? {} : { territoryCount });

    const startedAt = performance.now();
    const geometry = generateWorld(params);
    const generationMs = Math.round(performance.now() - startedAt);

    set({ geometry, params, generating: false, generationMs, selected: null, hovered: -1 });
  },

  setSelected: (selected) => set({ selected }),
  setHovered: (hovered) => set({ hovered }),
}));

/**
 * Builds the inspector summary for a territory.
 *
 * Takes a snapshot of the live values rather than a reference, so the panel
 * shows the state at the moment of selection and does not re-render on every
 * delta. Population and troops change 20 times a second; a panel that tracked
 * them live would re-render React at network rate for numbers no one is
 * reading that precisely.
 */
export function summariseTerritory(
  geometry: WorldGeometry,
  id: number,
  live: Partial<TerritoryLiveState> = {},
): TerritorySummary {
  const terrain = geometry.terrain[id] as Terrain;
  const modifiers = TERRAIN_MODIFIERS[terrain];

  return {
    id,
    terrain,
    terrainName: TERRAIN_NAMES[terrain] ?? 'Unknown',
    neighbourCount:
      (geometry.neighbourOffsets[id + 1] as number) - (geometry.neighbourOffsets[id] as number),
    area: Math.round(geometry.area[id] as number),
    owner: live.owner ?? OWNER_NONE,
    population: Math.floor(live.population ?? 0),
    troops: Math.floor(live.troops ?? 0),
    contested: live.contested ?? false,
    // Buildings arrive in Phase 5; the field exists so the panel layout is
    // final and does not need reworking when it lands.
    building: BuildingType.None,
    buildingName: BUILDING_NAMES[BuildingType.None],
    defenceMultiplier: modifiers.defenceMultiplier,
    incomeMultiplier: modifiers.incomeMultiplier,
    growthMultiplier: modifiers.growthMultiplier,
  };
}
