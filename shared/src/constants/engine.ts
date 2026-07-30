/**
 * Engine-level timing and capacity limits.
 *
 * These are *contract* constants: the client sizes its interpolation buffers and
 * the server sizes its typed arrays from the same numbers, so a mismatch would
 * be a desync rather than a cosmetic bug. They live in `shared/` for that reason.
 */

/* -------------------------------------------------------------------------- */
/* Tick rates                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The engine runs one master loop and drives each system from its own fixed
 * accumulator. Every interval below MUST be an integer multiple of
 * {@link MASTER_TICK_MS} so that no system ever drifts relative to another —
 * that property is what makes replays bit-reproducible.
 */
export const MASTER_TICK_MS = 50;

export const SYSTEM_INTERVAL_MS = {
  /** Population growth, food consumption. */
  population: 1000,
  /** Gold income, upkeep, building production. */
  economy: 1000,
  /** Attack resolution, troop transfer between territories. */
  combat: 100,
  /** Ship movement and naval engagements. */
  ships: 100,
  /** Missile flight integration and interception rolls. */
  missiles: 50,
  /** Building construction and upgrade progress. */
  buildings: 250,
  /** Bot decision making. Deliberately slow — bots must feel human-paced. */
  bots: 500,
  /** Leaderboard recomputation and broadcast. */
  leaderboard: 2000,
  /** Alliance timers, betrayal cooldowns, trade cooldowns. */
  diplomacy: 1000,
  /** Win-condition evaluation. */
  victory: 2000,
} as const satisfies Record<string, number>;

export type SystemName = keyof typeof SYSTEM_INTERVAL_MS;

/** Network broadcast rate. 20 Hz keeps bandwidth low; the client interpolates. */
export const NETWORK_TICK_HZ = 20;
export const NETWORK_TICK_MS = 1000 / NETWORK_TICK_HZ;

/**
 * The client renders this far behind the newest authoritative snapshot so that
 * it always has two states to interpolate between. Two network ticks of buffer
 * absorbs one dropped or reordered packet without visible stutter.
 */
export const CLIENT_INTERPOLATION_DELAY_MS = NETWORK_TICK_MS * 2;

/** A full (non-delta) snapshot is broadcast this often as a resync safety net. */
export const KEYFRAME_INTERVAL_MS = 10_000;

/** Simulation snapshot persisted to MongoDB at this cadence for crash recovery. */
export const PERSISTENCE_SNAPSHOT_INTERVAL_MS = 30_000;

/**
 * If a single master tick takes longer than this, the loop logs a warning and
 * drops accumulated time instead of spiralling into a death loop.
 */
export const TICK_BUDGET_WARN_MS = 40;

/** Maximum simulation time the loop will catch up in one pass, in ms. */
export const MAX_CATCHUP_MS = 500;

/* -------------------------------------------------------------------------- */
/* World capacity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Territory ids are transmitted as `Uint16`. `0xFFFF` is reserved as the "no
 * territory" sentinel, which caps the world at 65 535 territories — far above
 * the 5 000 target while keeping ids two bytes on the wire.
 */
export const MAX_TERRITORIES = 65_535;
export const TERRITORY_ID_NONE = 0xffff;

export const DEFAULT_TERRITORY_COUNT = 5000;
export const MIN_TERRITORY_COUNT = 256;

/**
 * Player slots are also `Uint16` so that owner arrays are a single typed array
 * indexed by territory id. `0xFFFF` means unowned (neutral).
 */
export const MAX_PLAYER_SLOTS = 1024;
export const OWNER_NONE = 0xffff;

/** Hard cap on concurrent human players per match instance. */
export const MAX_PLAYERS_PER_MATCH = 256;
/** Hard cap on bots per match instance. */
export const MAX_BOTS_PER_MATCH = 128;
/** Spectators are cheap (read-only, no simulation cost) so the cap is higher. */
export const MAX_SPECTATORS_PER_MATCH = 512;

export const MAX_ALLIANCE_SIZE = 8;

/** Upper bound on neighbours a Voronoi cell may have; used to size the CSR graph. */
export const MAX_NEIGHBOURS_PER_TERRITORY = 24;

/* -------------------------------------------------------------------------- */
/* World geometry                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The world is a fixed rectangle in simulation units. Rendering scales it to
 * screen space; the simulation never sees pixels. Keeping this constant lets us
 * store coordinates as `Float32` without precision anxiety.
 */
export const WORLD_WIDTH = 8192;
export const WORLD_HEIGHT = 8192;

/* -------------------------------------------------------------------------- */
/* Networking limits                                                           */
/* -------------------------------------------------------------------------- */

/** Grace period during which a dropped player keeps their territories. */
export const RECONNECT_GRACE_MS = 90_000;

/** Rejected if a single client frame exceeds this. Cheap anti-flood guard. */
export const MAX_PACKET_BYTES = 8 * 1024;

export const MAX_CHAT_MESSAGE_LENGTH = 240;
export const MAX_PLAYER_NAME_LENGTH = 20;
export const MIN_PLAYER_NAME_LENGTH = 2;
export const MAX_ROOM_NAME_LENGTH = 32;

/** Per-connection command budget, enforced by a token bucket. */
export const RATE_LIMITS = {
  /** Most gameplay commands share one bucket. */
  command: { capacity: 30, refillPerSecond: 12 },
  /** Chat is bucketed separately so spam cannot starve gameplay input. */
  chat: { capacity: 5, refillPerSecond: 0.5 },
  /** Alliance invites/requests — deliberately harsh to prevent harassment. */
  diplomacy: { capacity: 6, refillPerSecond: 0.2 },
} as const;
