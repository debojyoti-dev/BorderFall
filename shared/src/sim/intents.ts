/**
 * Intents — the only way a player can influence the simulation.
 *
 * ## Why intents rather than commands
 *
 * Under lockstep the server does not simulate. It collects intents for a turn,
 * relays the bundle to every client, and each client's simulation applies them
 * identically. An intent is therefore not a request that gets a reply — it is
 * an *input* that will be replayed on every machine, including in a replay
 * years later.
 *
 * That imposes two rules on everything in this file:
 *
 * 1. **Intents must be plain, serialisable data.** No functions, no object
 *    references, no `Date`. They are JSON on the wire and stored verbatim in
 *    replays.
 * 2. **Intents may not carry derived state.** An intent says "attack player 3
 *    with 40 % of my troops", never "attack player 3 with 12 043 troops". The
 *    absolute figure would be computed from the sender's local view, which is
 *    a few hundred milliseconds ahead of or behind everyone else's — and any
 *    such divergence desyncs every client in the match.
 */

export const IntentType = {
  Spawn: 0,
  Attack: 1,
  /** Cancel an in-progress attack and keep the surviving troops. */
  Retreat: 2,
  Build: 3,
  Boat: 4,
  Nuke: 5,
  AllianceRequest: 6,
  AllianceResponse: 7,
  BreakAlliance: 8,
  Donate: 9,
  Embargo: 10,
  QuickChat: 11,
  Emoji: 12,
  /** Marks a player as the sender's declared target, visible to allies. */
  TargetPlayer: 13,
} as const;

export type IntentType = (typeof IntentType)[keyof typeof IntentType];

interface BaseIntent {
  readonly type: IntentType;
  /** Slot of the issuing player. Stamped by the server, never by the client. */
  readonly slot: number;
}

/** Claim a starting position during the spawn phase. */
export interface SpawnIntent extends BaseIntent {
  readonly type: typeof IntentType.Spawn;
  readonly tile: number;
}

/**
 * Attack a neighbouring player, or unclaimed land.
 *
 * `ratio` is a fraction of the sender's troop pool. See the note above on why
 * this is not an absolute count.
 */
export interface AttackIntent extends BaseIntent {
  readonly type: typeof IntentType.Attack;
  /** Defending slot, or `TILE_OWNER_NONE` to expand into neutral ground. */
  readonly target: number;
  readonly ratio: number;
}

export interface RetreatIntent extends BaseIntent {
  readonly type: typeof IntentType.Retreat;
  readonly target: number;
}

export interface BuildIntent extends BaseIntent {
  readonly type: typeof IntentType.Build;
  readonly structure: number;
  readonly tile: number;
}

/** Amphibious assault: troops cross water to land on a coastal tile. */
export interface BoatIntent extends BaseIntent {
  readonly type: typeof IntentType.Boat;
  readonly fromTile: number;
  readonly toTile: number;
  readonly ratio: number;
}

export interface NukeIntent extends BaseIntent {
  readonly type: typeof IntentType.Nuke;
  readonly missileType: number;
  readonly tile: number;
}

export interface AllianceRequestIntent extends BaseIntent {
  readonly type: typeof IntentType.AllianceRequest;
  readonly target: number;
}

export interface AllianceResponseIntent extends BaseIntent {
  readonly type: typeof IntentType.AllianceResponse;
  readonly requester: number;
  readonly accept: boolean;
}

export interface BreakAllianceIntent extends BaseIntent {
  readonly type: typeof IntentType.BreakAlliance;
  readonly target: number;
}

export interface DonateIntent extends BaseIntent {
  readonly type: typeof IntentType.Donate;
  readonly target: number;
  /** True to donate troops, false for gold. */
  readonly troops: boolean;
  readonly ratio: number;
}

export interface EmbargoIntent extends BaseIntent {
  readonly type: typeof IntentType.Embargo;
  readonly target: number;
  readonly enabled: boolean;
}

/**
 * Structured chat.
 *
 * A phrase id plus an optional target rather than free text: no moderation
 * burden, no harassment vector, and it works across every language without
 * translation. For a game whose diplomacy is the point, this is strictly
 * better than a text box.
 */
export interface QuickChatIntent extends BaseIntent {
  readonly type: typeof IntentType.QuickChat;
  readonly phraseId: number;
  readonly target: number;
}

export interface EmojiIntent extends BaseIntent {
  readonly type: typeof IntentType.Emoji;
  readonly emojiId: number;
  readonly target: number;
}

export interface TargetPlayerIntent extends BaseIntent {
  readonly type: typeof IntentType.TargetPlayer;
  readonly target: number;
}

export type Intent =
  | SpawnIntent
  | AttackIntent
  | RetreatIntent
  | BuildIntent
  | BoatIntent
  | NukeIntent
  | AllianceRequestIntent
  | AllianceResponseIntent
  | BreakAllianceIntent
  | DonateIntent
  | EmbargoIntent
  | QuickChatIntent
  | EmojiIntent
  | TargetPlayerIntent;

/**
 * One turn's worth of intents, as relayed by the server.
 *
 * Turns are the unit of lockstep synchronisation. Every client must apply turn
 * *n* before turn *n+1*, and applying the same turns in the same order from the
 * same seed must produce byte-identical state. A turn with no intents is still
 * sent, because its arrival is what advances the simulation.
 */
export interface Turn {
  readonly turn: number;
  readonly intents: readonly Intent[];
}
