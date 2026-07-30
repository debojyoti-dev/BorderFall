/**
 * Building kinds. Encoded as `Uint8`; `BuildingType.None` (0) means the
 * territory has no structure, which lets the server store buildings in a flat
 * `Uint8Array` indexed by territory id rather than a map.
 *
 * Values are frozen — append only. See {@link Terrain} for the rationale.
 */
export const BuildingType = {
  None: 0,
  /** Raises population cap and growth; the economic backbone. */
  City: 1,
  /** Large flat defence bonus for the holding territory. */
  Fort: 2,
  /** Enables naval construction and sea traversal from this territory. */
  Port: 3,
  /** Required to launch ballistic weapons. */
  MissileSilo: 4,
  /** Increases troop production rate. */
  Factory: 5,
  /** Enables air units and long-range logistics (reserved). */
  Airport: 6,
  /** Extends vision radius; reveals incoming missiles earlier. */
  Radar: 7,
  /** Grants interception chance against missiles within its radius. */
  AntiAir: 8,
} as const;

export type BuildingType = (typeof BuildingType)[keyof typeof BuildingType];

export const ALL_BUILDING_TYPES: readonly BuildingType[] = [
  BuildingType.City,
  BuildingType.Fort,
  BuildingType.Port,
  BuildingType.MissileSilo,
  BuildingType.Factory,
  BuildingType.Airport,
  BuildingType.Radar,
  BuildingType.AntiAir,
];

export const BUILDING_NAMES: Readonly<Record<BuildingType, string>> = {
  [BuildingType.None]: 'None',
  [BuildingType.City]: 'City',
  [BuildingType.Fort]: 'Fort',
  [BuildingType.Port]: 'Port',
  [BuildingType.MissileSilo]: 'Missile Silo',
  [BuildingType.Factory]: 'Factory',
  [BuildingType.Airport]: 'Airport',
  [BuildingType.Radar]: 'Radar',
  [BuildingType.AntiAir]: 'Anti-Air',
};
