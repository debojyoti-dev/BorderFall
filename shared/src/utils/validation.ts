import { MAX_PLAYER_NAME_LENGTH, MIN_PLAYER_NAME_LENGTH } from '../constants/engine.js';

/**
 * Input sanitisation shared by client (immediate feedback) and server
 * (enforcement). The server always re-runs these — client-side validation is a
 * convenience, never a control.
 */

/**
 * True for code points that must never survive into a name, chat line or log.
 *
 * Implemented as a numeric scan rather than a regex for two reasons: the
 * ranges include NUL and other bytes that are hostile to have sitting literally
 * in a source file, and a single pass over char codes is measurably faster than
 * two regex replacements on the chat hot path.
 */
function isUnsafeCodePoint(code: number): boolean {
  // C0 controls (excluding nothing — even tab/newline are unwanted in a name).
  if (code <= 0x1f) return true;
  // DEL and the C1 control block.
  if (code >= 0x7f && code <= 0x9f) return true;
  // Zero-width space / non-joiner / joiner, and the LTR/RTL marks.
  if (code >= 0x200b && code <= 0x200f) return true;
  // Bidirectional embedding and override controls — the impersonation vector:
  // an RTL override lets a player render a leaderboard name that reads
  // identically to someone else's.
  if (code >= 0x202a && code <= 0x202e) return true;
  // Invisible separators and the bidi isolate controls.
  if (code >= 0x2060 && code <= 0x206f) return true;
  // Zero-width no-break space (BOM), which breaks naive string comparison.
  if (code === 0xfeff) return true;
  return false;
}

export function stripUnsafeCharacters(input: string): string {
  // Fast path: the overwhelming majority of input is already clean, so avoid
  // building a new string unless we actually find something to remove.
  let needsWork = false;
  for (let i = 0; i < input.length; i++) {
    if (isUnsafeCodePoint(input.charCodeAt(i))) {
      needsWork = true;
      break;
    }
  }
  if (!needsWork) return input;

  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (!isUnsafeCodePoint(code)) out += input[i];
  }
  return out;
}

/** Collapses whitespace, strips spoofing characters, enforces the length cap. */
export function sanitisePlayerName(raw: string): string {
  return stripUnsafeCharacters(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_PLAYER_NAME_LENGTH);
}

export function isValidPlayerName(name: string): boolean {
  return name.length >= MIN_PLAYER_NAME_LENGTH && name.length <= MAX_PLAYER_NAME_LENGTH;
}

export function sanitiseChatMessage(raw: string, maxLength: number): string {
  return stripUnsafeCharacters(raw)
    .replace(/\s{3,}/g, '  ')
    .trim()
    .slice(0, maxLength);
}

/** Narrow `unknown` to a finite number in range. Rejects NaN, Infinity, strings. */
export function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Narrow `unknown` to a safe integer in range. */
export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** Membership test against a frozen enum object, for decoding wire values. */
export function isEnumValue<T extends Record<string, number>>(
  enumObject: T,
  value: unknown,
): value is T[keyof T] {
  return typeof value === 'number' && Object.values(enumObject).includes(value);
}
