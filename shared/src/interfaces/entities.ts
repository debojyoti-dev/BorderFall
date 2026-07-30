import type {
  BuildingType,
  ChatChannel,
  ConnectionRole,
  DiplomacyState,
  MissileType,
  PlayerStatus,
  ShipType,
} from '../enums/index.js';

/**
 * The *dynamic* half of the world — everything that changes during a match and
 * therefore has to cross the network.
 *
 * These are plain view objects: the server's authoritative storage is
 * structure-of-arrays (see `server/src/engine/WorldState.ts`), and these
 * interfaces describe what a single entity looks like once read out of it. The
 * client stores them the same way for the same cache reasons; these shapes are
 * the contract, not the storage.
 */

/* -------------------------------------------------------------------------- */
/* Territory                                                                   */
/* -------------------------------------------------------------------------- */

export interface TerritoryStateView {
  readonly id: number;
  /** Player slot, or `OWNER_NONE` when neutral. */
  readonly owner: number;
  readonly population: number;
  readonly troops: number;
  readonly building: BuildingType;
  readonly buildingLevel: number;
  /** Current structure hit points; 0 when there is no building. */
  readonly buildingHp: number;
  /** Construction progress 0–1; 1 means operational. */
  readonly constructionProgress: number;
  /** True while an outbound attack originating here is resolving. */
  readonly contested: boolean;
}

/**
 * Bit flags marking which fields of a territory changed in a given tick.
 *
 * Delta encoding sends this mask plus only the changed fields. In steady state
 * fewer than 2 % of territories change per tick, so a delta is roughly two
 * orders of magnitude smaller than a full snapshot.
 */
export const TerritoryField = {
  Owner: 1 << 0,
  Population: 1 << 1,
  Troops: 1 << 2,
  Building: 1 << 3,
  BuildingLevel: 1 << 4,
  BuildingHp: 1 << 5,
  Construction: 1 << 6,
  Contested: 1 << 7,
} as const;

export type TerritoryField = (typeof TerritoryField)[keyof typeof TerritoryField];

/* -------------------------------------------------------------------------- */
/* Player                                                                      */
/* -------------------------------------------------------------------------- */

export interface PlayerView {
  readonly slot: number;
  readonly name: string;
  readonly isBot: boolean;
  readonly status: PlayerStatus;
  readonly allianceId: number | null;
  /** Packed RGB, derived from the slot — see `playerColor`. */
  readonly color: number;
}

/** Per-player economy and score. Broadcast in full only to the owning player. */
export interface PlayerResourcesView {
  readonly gold: number;
  readonly food: number;
  readonly population: number;
  readonly troops: number;
  readonly territoryCount: number;
  readonly cityCount: number;
}

export interface PlayerStatsView {
  readonly kills: number;
  readonly deaths: number;
  readonly territoriesCaptured: number;
  readonly territoriesLost: number;
  readonly missilesLaunched: number;
  readonly missilesIntercepted: number;
  readonly shipsBuilt: number;
  readonly shipsLost: number;
  readonly goldEarned: number;
  readonly goldSpent: number;
}

/* -------------------------------------------------------------------------- */
/* Units                                                                       */
/* -------------------------------------------------------------------------- */

export interface ShipView {
  readonly id: number;
  readonly owner: number;
  readonly type: ShipType;
  readonly x: number;
  readonly y: number;
  /** Heading in radians; drives sprite rotation and wake direction. */
  readonly heading: number;
  readonly hp: number;
  /** Troops aboard a transport. */
  readonly cargo: number;
  /** Destination territory id, or `TERRITORY_ID_NONE` when idle. */
  readonly destination: number;
}

export interface MissileView {
  readonly id: number;
  readonly owner: number;
  readonly type: MissileType;
  /** Launch position, in world units. */
  readonly originX: number;
  readonly originY: number;
  readonly targetX: number;
  readonly targetY: number;
  /** Server timestamp of launch; the client extrapolates position from this. */
  readonly launchedAt: number;
  /** Total flight duration in ms. Position is a pure function of these three. */
  readonly flightTimeMs: number;
  /** True once an interception roll has succeeded. */
  readonly intercepted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Alliance & diplomacy                                                        */
/* -------------------------------------------------------------------------- */

export interface AllianceView {
  readonly id: number;
  readonly name: string;
  readonly leaderSlot: number;
  readonly memberSlots: readonly number[];
  readonly createdAt: number;
}

export interface DiplomacyRelation {
  readonly a: number;
  readonly b: number;
  readonly state: DiplomacyState;
  /** Timestamp after which the relation may be changed again. */
  readonly lockedUntil: number;
}

/* -------------------------------------------------------------------------- */
/* Chat & leaderboard                                                          */
/* -------------------------------------------------------------------------- */

export interface ChatMessageView {
  readonly id: number;
  readonly channel: ChatChannel;
  /** Sender slot, or `-1` for system messages. */
  readonly senderSlot: number;
  readonly senderName: string;
  readonly text: string;
  readonly timestamp: number;
}

export interface LeaderboardEntry {
  readonly rank: number;
  readonly slot: number;
  readonly name: string;
  readonly isBot: boolean;
  readonly population: number;
  readonly troops: number;
  /** Owned territories as a fraction of all land territories, 0–1. */
  readonly territoryShare: number;
  readonly gold: number;
  readonly cities: number;
  readonly kills: number;
  readonly deaths: number;
  /** Composite score driving the ordering. */
  readonly score: number;
}

/* -------------------------------------------------------------------------- */
/* Room & session                                                              */
/* -------------------------------------------------------------------------- */

export interface RoomSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly mode: number;
  readonly visibility: number;
  readonly state: number;
  readonly playerCount: number;
  readonly botCount: number;
  readonly spectatorCount: number;
  readonly maxPlayers: number;
  readonly territoryCount: number;
  readonly requiresPassword: boolean;
  readonly createdAt: number;
  /** Elapsed match time in ms; 0 while in lobby. */
  readonly elapsedMs: number;
}

export interface SessionIdentity {
  readonly accountId: string;
  readonly name: string;
  readonly isGuest: boolean;
  readonly role: ConnectionRole;
}
