/** Naval hull classes. Encoded as `Uint8`; append only. */
export const ShipType = {
  /** Carries land troops across water. Weak in combat. */
  Transport: 0,
  /** Fast escort. Cheap, good against transports and submarines. */
  Destroyer: 1,
  /** Heavy surface combatant. Can bombard adjacent coastal territories. */
  Battleship: 2,
  /** Stealth hull. Invisible unless adjacent to a Radar or Destroyer. */
  Submarine: 3,
  /** Enforces a blockade, halving the income of the territories it besieges. */
  Blockader: 4,
} as const;

export type ShipType = (typeof ShipType)[keyof typeof ShipType];

export const ALL_SHIP_TYPES: readonly ShipType[] = [
  ShipType.Transport,
  ShipType.Destroyer,
  ShipType.Battleship,
  ShipType.Submarine,
  ShipType.Blockader,
];

/** Ballistic and cruise weapon classes. Encoded as `Uint8`; append only. */
export const MissileType = {
  /** Low yield, short range, cheap. Single territory blast. */
  Cruise: 0,
  /** Medium yield. Destroys buildings and most of the population in radius. */
  Atomic: 1,
  /** High yield, wide blast, long travel time — highly interceptable. */
  Hydrogen: 2,
  /** Splits into independently targeted warheads on terminal approach. */
  Mirv: 3,
} as const;

export type MissileType = (typeof MissileType)[keyof typeof MissileType];

export const ALL_MISSILE_TYPES: readonly MissileType[] = [
  MissileType.Cruise,
  MissileType.Atomic,
  MissileType.Hydrogen,
  MissileType.Mirv,
];

export const MISSILE_NAMES: Readonly<Record<MissileType, string>> = {
  [MissileType.Cruise]: 'Cruise Missile',
  [MissileType.Atomic]: 'Atomic Bomb',
  [MissileType.Hydrogen]: 'Hydrogen Bomb',
  [MissileType.Mirv]: 'MIRV',
};
