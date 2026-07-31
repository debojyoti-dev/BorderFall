import type {
  AllianceView,
  ChatMessageView,
  LeaderboardEntry,
  MissileView,
  PlayerResourcesView,
  PlayerStatsView,
  PlayerView,
  ShipView,
  TerritoryStateView,
} from '../interfaces/entities.js';
import type { MapGenParams } from '../interfaces/world.js';

/**
 * Server → client payloads.
 *
 * The transport strategy is deliberately two-tier:
 *
 * - **`MatchInitPacket`** is sent once on join. It contains the map *seed*, not
 *   the map. The client runs the same deterministic generator and reconstructs
 *   an identical 5 000-cell world locally.
 * - **`WorldDeltaPacket`** is sent at 20 Hz and carries only what changed,
 *   encoded into flat typed arrays. A periodic `WorldSnapshotPacket` acts as a
 *   keyframe so a client that missed a delta can resynchronise without
 *   rejoining.
 */

/* -------------------------------------------------------------------------- */
/* Join / init                                                                 */
/* -------------------------------------------------------------------------- */

export interface MatchInitPacket {
  readonly roomId: string;
  readonly matchId: string;
  /** Everything needed to regenerate the world locally. */
  readonly mapParams: MapGenParams;
  /** The receiving client's slot, or `-1` for spectators. */
  readonly yourSlot: number;
  /** Opaque token that reclaims this slot after a disconnect. */
  readonly reconnectToken: string;
  readonly players: readonly PlayerView[];
  readonly alliances: readonly AllianceView[];
  /** Server clock at send time, for latency estimation and clock sync. */
  readonly serverTime: number;
  /** Simulation tick index at send time. */
  readonly tick: number;
  /** Full territory state, so the client starts from a known-good baseline. */
  readonly snapshot: WorldSnapshotPacket;
}

/* -------------------------------------------------------------------------- */
/* World state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A complete territory state dump, sent on join and as a periodic keyframe.
 *
 * Transmitted as parallel arrays rather than an array of objects: for 5 000
 * territories, `{id, owner, population, ...}` objects cost roughly 400 KB of
 * JSON, whereas these arrays serialise to compact binary and deserialise
 * straight into the client's own typed arrays with no per-entity allocation.
 */
export interface WorldSnapshotPacket {
  readonly tick: number;
  readonly serverTime: number;
  /** Length equals the world's territory count; index is the territory id. */
  readonly owner: Uint16Array;
  readonly population: Uint32Array;
  readonly troops: Uint32Array;
  readonly building: Uint8Array;
  readonly buildingLevel: Uint8Array;
  /** Construction progress quantised to 0–255. */
  readonly construction: Uint8Array;
  /** 1 while an assault is resolving on that territory. */
  readonly contested: Uint8Array;
  readonly ships: readonly ShipView[];
  readonly missiles: readonly MissileView[];
}

/**
 * Incremental world update.
 *
 * `ids[i]` identifies the changed territory and `fields[i]` is a
 * {@link TerritoryField} bitmask describing which of the parallel value arrays
 * carry meaningful data for that entry. Unchanged fields are still present in
 * the arrays (typed arrays cannot be sparse) but must be ignored — reading them
 * would apply stale values.
 */
export interface WorldDeltaPacket {
  readonly tick: number;
  readonly serverTime: number;
  /** Tick this delta applies on top of; a mismatch triggers a resync request. */
  readonly baseTick: number;

  readonly ids: Uint16Array;
  readonly fields: Uint8Array;
  readonly owner: Uint16Array;
  readonly population: Uint32Array;
  readonly troops: Uint32Array;
  readonly building: Uint8Array;
  readonly buildingLevel: Uint8Array;
  readonly construction: Uint8Array;
  readonly contested: Uint8Array;

  /** Ships that moved, spawned or changed state this tick. */
  readonly ships: readonly ShipView[];
  /** Ship ids removed since the last delta. */
  readonly removedShips: readonly number[];
  readonly missiles: readonly MissileView[];
  readonly removedMissiles: readonly number[];
}

/* -------------------------------------------------------------------------- */
/* Player-scoped updates                                                       */
/* -------------------------------------------------------------------------- */

/** Sent only to the owning player — resources are private information. */
export interface ResourceUpdatePacket {
  readonly tick: number;
  readonly resources: PlayerResourcesView;
}

export interface PlayerListPacket {
  readonly players: readonly PlayerView[];
}

export interface LeaderboardPacket {
  readonly tick: number;
  readonly entries: readonly LeaderboardEntry[];
}

export interface AllianceUpdatePacket {
  readonly alliances: readonly AllianceView[];
  /** Invites awaiting the receiving player's response. */
  readonly pendingInvites: readonly number[];
}

/* -------------------------------------------------------------------------- */
/* Discrete events                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One-off notable events, surfaced separately from state deltas.
 *
 * State deltas tell the client *what is true now*; these tell it *what just
 * happened*, which is what drives transient feedback — a capture flash, a
 * mushroom cloud, a kill feed line. Deriving these from deltas alone is
 * impossible: a territory changing owner twice between two 20 Hz frames would
 * otherwise be silently collapsed into a single visible change.
 */
export interface TerritoryCapturedEvent {
  readonly territory: number;
  readonly previousOwner: number;
  readonly newOwner: number;
  readonly troopsLost: number;
  readonly tick: number;
}

export interface CombatResolvedEvent {
  readonly from: number;
  readonly to: number;
  readonly attackerSlot: number;
  readonly defenderSlot: number;
  readonly attackerLosses: number;
  readonly defenderLosses: number;
  readonly captured: boolean;
  readonly critical: boolean;
  readonly tick: number;
}

export interface MissileLaunchedEvent {
  readonly missile: MissileView;
}

export interface MissileImpactEvent {
  readonly missileId: number;
  readonly x: number;
  readonly y: number;
  readonly missileType: number;
  readonly intercepted: boolean;
  readonly populationKilled: number;
  readonly troopsKilled: number;
  readonly territoriesHit: readonly number[];
  readonly tick: number;
}

export interface BuildingCompletedEvent {
  readonly territory: number;
  readonly building: number;
  readonly level: number;
  readonly ownerSlot: number;
}

export interface PlayerEliminatedEvent {
  readonly slot: number;
  readonly bySlot: number;
  readonly finalRank: number;
}

export interface MatchEndedPacket {
  readonly matchId: string;
  readonly winnerSlot: number | null;
  readonly finalLeaderboard: readonly LeaderboardEntry[];
  readonly stats: Readonly<Record<number, PlayerStatsView>>;
  readonly durationMs: number;
  /** Identifier for fetching the replay from the REST API. */
  readonly replayId: string | null;
}

export interface ChatPacket {
  readonly message: ChatMessageView;
}

export interface SystemNoticePacket {
  /** Machine-readable key so the client can localise and style the notice. */
  readonly code: string;
  readonly text: string;
  readonly severity: 'info' | 'warning' | 'error';
}

/** Full territory view, sent on demand when a player inspects a territory. */
export interface TerritoryDetailPacket {
  readonly territory: TerritoryStateView;
}
