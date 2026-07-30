/**
 * Player and terrain palettes.
 *
 * Colours are contract data, not presentation trivia: a player's colour is
 * derived from their slot index so that every client — and every replay viewer,
 * years later — renders the same empire in the same colour without the server
 * ever transmitting a colour value.
 */

/**
 * 32 visually separated hues, ordered so that consecutive slots are maximally
 * distinguishable. Beyond 32 players the palette repeats with a lightness shift
 * applied by {@link playerColor}, which keeps neighbouring empires readable at
 * minimap scale.
 */
export const PLAYER_PALETTE: readonly number[] = [
  0xe6194b, 0x3cb44b, 0x4363d8, 0xf58231, 0x911eb4, 0x42d4f4, 0xf032e6, 0xbfef45, 0xfabed4,
  0x469990, 0xdcbeff, 0x9a6324, 0xfffac8, 0x800000, 0xaaffc3, 0x808000, 0xffd8b1, 0x000075,
  0xa9a9a9, 0xff6b6b, 0x4ecdc4, 0xffe66d, 0x1a936f, 0xc44536, 0x6a4c93, 0xf4a261, 0x2a9d8f,
  0xe76f51, 0x8ecae6, 0x219ebc, 0xffb703, 0xfb8500,
];

/** Colour used for unowned territory. */
export const NEUTRAL_COLOR = 0x5a6272;

/** Base fill per terrain type, used when a territory is unowned. */
export const TERRAIN_COLORS: Readonly<Record<number, number>> = {
  0: 0x1b3a5c, // Ocean
  1: 0x2d6ba3, // Coast
  2: 0x3f88c5, // Lake
  3: 0x7c9a5a, // Plains
  4: 0x3f6b3a, // Forest
  5: 0x8a7f5c, // Hills
  6: 0x6b6357, // Mountain
  7: 0xc9b079, // Desert
  8: 0xcfd8dc, // Tundra
};

/**
 * Deterministic slot → colour mapping.
 *
 * Slots past the palette length wrap around with a progressively darker shade,
 * so slot 0 and slot 32 share a hue but never a value.
 */
export function playerColor(slot: number): number {
  const size = PLAYER_PALETTE.length;
  const base = PLAYER_PALETTE[slot % size] ?? NEUTRAL_COLOR;
  const cycle = Math.floor(slot / size);
  if (cycle === 0) return base;

  // Each wrap darkens by 18 %, floored so the colour never collapses to black.
  const factor = Math.max(0.35, 1 - cycle * 0.18);
  const r = Math.round(((base >> 16) & 0xff) * factor);
  const g = Math.round(((base >> 8) & 0xff) * factor);
  const b = Math.round((base & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/** Convenience for CSS/DOM contexts that need `#rrggbb`. */
export function toHexString(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
