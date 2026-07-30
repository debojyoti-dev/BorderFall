/** Lifecycle of a match instance on the server. */
export const MatchState = {
  /** Accepting players; simulation is not running. */
  Lobby: 0,
  /** Countdown before the first tick. Joins still allowed. */
  Starting: 1,
  /** Simulation running. Late joins allowed only if the room permits it. */
  Running: 2,
  /** A win condition fired; scores are being finalised. */
  Ending: 3,
  /** Terminal. The instance is scheduled for teardown. */
  Finished: 4,
} as const;

export type MatchState = (typeof MatchState)[keyof typeof MatchState];

/** How a room may be discovered and entered. */
export const RoomVisibility = {
  /** Listed in the public browser, anyone may join. */
  Public: 0,
  /** Unlisted, joinable only with the room code. */
  Private: 1,
  /** Listed but requires a password. */
  PasswordProtected: 2,
} as const;

export type RoomVisibility = (typeof RoomVisibility)[keyof typeof RoomVisibility];

/** Rule-set presets applied at room creation. */
export const GameMode = {
  /** Standard free-for-all. */
  FreeForAll: 0,
  /** Alliance-limited free-for-all with a territory-percentage win condition. */
  Domination: 1,
  /** Solo versus bots, no ranking impact. */
  Practice: 2,
  /** Rated, bot-free, fixed settings. */
  Ranked: 3,
  /** Fixed teams assigned at start. */
  TeamBattle: 4,
} as const;

export type GameMode = (typeof GameMode)[keyof typeof GameMode];

/** Role a connection holds inside a room. */
export const ConnectionRole = {
  /** Full participant; may issue commands. */
  Player: 0,
  /** Read-only observer; camera control only, all commands rejected. */
  Spectator: 1,
  /** Elevated observer with moderation abilities. */
  Moderator: 2,
} as const;

export type ConnectionRole = (typeof ConnectionRole)[keyof typeof ConnectionRole];

/** Per-player status inside a running match. */
export const PlayerStatus = {
  /** Connected and playing. */
  Active: 0,
  /** Socket dropped; state retained until the reconnect grace period expires. */
  Disconnected: 1,
  /** Lost all territories. */
  Eliminated: 2,
  /** Left voluntarily. */
  Surrendered: 3,
} as const;

export type PlayerStatus = (typeof PlayerStatus)[keyof typeof PlayerStatus];

/** Diplomatic relation between two players. Symmetric unless noted. */
export const DiplomacyState = {
  /** Default. Attacks permitted both ways. */
  Neutral: 0,
  /** Attacks blocked, friendly traversal allowed, alliance chat shared. */
  Allied: 1,
  /** Explicit hostility; skips the betrayal cooldown on attack. */
  War: 2,
  /** Asymmetric: a request is pending from one side to the other. */
  Pending: 3,
} as const;

export type DiplomacyState = (typeof DiplomacyState)[keyof typeof DiplomacyState];

/** Chat routing channel. */
export const ChatChannel = {
  Global: 0,
  Alliance: 1,
  Private: 2,
  /** Server-authored notices. Clients may not send on this channel. */
  System: 3,
  /** Visible only to spectators. */
  Spectator: 4,
} as const;

export type ChatChannel = (typeof ChatChannel)[keyof typeof ChatChannel];
