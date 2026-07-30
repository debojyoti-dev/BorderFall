/**
 * Identifier helpers.
 *
 * Branded primitives give us compile-time separation between the several
 * numeric id spaces in the simulation (territory / player slot / unit) at zero
 * runtime cost. Passing a `PlayerSlot` where a `TerritoryId` is expected is one
 * of the easiest and most damaging mistakes to make in an SoA engine where
 * everything is "just a number"; the brand makes it a type error.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type TerritoryId = Brand<number, 'TerritoryId'>;
export type PlayerSlot = Brand<number, 'PlayerSlot'>;
export type UnitId = Brand<number, 'UnitId'>;
export type MissileId = Brand<number, 'MissileId'>;
export type AllianceId = Brand<number, 'AllianceId'>;

export const asTerritoryId = (n: number): TerritoryId => n as TerritoryId;
export const asPlayerSlot = (n: number): PlayerSlot => n as PlayerSlot;
export const asUnitId = (n: number): UnitId => n as UnitId;
export const asMissileId = (n: number): MissileId => n as MissileId;
export const asAllianceId = (n: number): AllianceId => n as AllianceId;

/**
 * Monotonic id allocator for runtime entities (ships, missiles, orders).
 *
 * Wraps at 2^31 rather than growing unbounded so ids stay in the SMI range and
 * remain cheap to store in typed arrays. A match will never live long enough to
 * see a collision, but wrapping is still the correct behaviour over throwing.
 */
export class IdAllocator {
  private next: number;

  constructor(start = 1) {
    this.next = start;
  }

  allocate(): number {
    const id = this.next;
    this.next = this.next >= 0x7fffffff ? 1 : this.next + 1;
    return id;
  }

  /** Current cursor; persisted alongside a simulation snapshot. */
  get cursor(): number {
    return this.next;
  }

  restore(cursor: number): void {
    this.next = cursor;
  }
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Human-shareable room code.
 *
 * The alphabet omits `I`, `L`, `O`, `0` and `1` — codes get read aloud over
 * voice chat, and those five characters cause the overwhelming majority of
 * mis-entries.
 */
export function generateRoomCode(random: () => number, length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    const index = Math.floor(random() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length;
    code += ROOM_CODE_ALPHABET[index];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length < 4 || code.length > 10) return false;
  for (const char of code) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}
