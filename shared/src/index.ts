/**
 * `@borderfall/shared` — the contract layer.
 *
 * Everything in this package is imported by *both* the authoritative server and
 * the browser client. It therefore has three hard rules, enforced by ESLint:
 *
 * 1. **No runtime dependencies.** No Express, no Pixi, no React, no Mongoose.
 * 2. **No environment assumptions.** No `window`, no `process`, no `fs`.
 * 3. **No mutable module state.** Two matches run in one Node process; a
 *    module-level mutable would leak state between them.
 *
 * What belongs here: wire formats, enums, balance data, and any logic that must
 * produce byte-identical results on both sides (the PRNG, the map generator,
 * rate-limit accounting).
 */

export * from './enums/index.js';
export * from './constants/index.js';
export * from './interfaces/index.js';
export * from './packets/index.js';
export * from './events/index.js';
export * from './utils/index.js';
export * from './world/index.js';

/** Bumped whenever a wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;
