import type { BuildingType, ChatChannel, MissileType, ShipType } from '../enums/index.js';

/**
 * Client → server payloads.
 *
 * Every one of these is an *intention*, never a result. The client says "I want
 * to attack territory 42 with 60 % of my garrison"; it never says "I now own
 * territory 42". The server is free to reject, clamp or delay any of them.
 *
 * Two conventions run through all commands:
 *
 * - **`seq`**: a client-monotonic sequence number. The server echoes it in the
 *   ack or reject so the client can tie a specific button press to a specific
 *   outcome, retire an optimistic UI state, and surface the right error on the
 *   right control — impossible with fire-and-forget events.
 * - **Ratios, not absolutes.** Troop commitments are sent as a fraction of the
 *   garrison rather than a troop count. The client's view of the garrison is
 *   always a few hundred milliseconds stale, so an absolute count would
 *   routinely be wrong by the time it arrived; a ratio is always meaningful and
 *   removes an entire class of "insufficient troops" rejections caused purely
 *   by latency.
 */

export interface CommandEnvelope {
  /** Client-monotonic sequence number, unique per connection. */
  readonly seq: number;
}

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

export interface JoinMatchCommand extends CommandEnvelope {
  readonly roomId: string;
  readonly password?: string;
  /** Request to join as a spectator instead of a player. */
  readonly asSpectator?: boolean;
  /** Presented on reconnect to reclaim an existing player slot. */
  readonly reconnectToken?: string;
}

export interface LeaveMatchCommand extends CommandEnvelope {
  /** Surrender forfeits territories immediately instead of idling out. */
  readonly surrender: boolean;
}

/* -------------------------------------------------------------------------- */
/* Military                                                                    */
/* -------------------------------------------------------------------------- */

export interface AttackCommand extends CommandEnvelope {
  readonly from: number;
  readonly to: number;
  /** Fraction of the source garrison to commit, 0–1. */
  readonly ratio: number;
}

/** Reinforce a friendly (own or allied) territory from an adjacent one. */
export interface TransferTroopsCommand extends CommandEnvelope {
  readonly from: number;
  readonly to: number;
  readonly ratio: number;
}

/** Convert population into troops in a specific territory. */
export interface MobiliseCommand extends CommandEnvelope {
  readonly territory: number;
  readonly ratio: number;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

export interface BuildCommand extends CommandEnvelope {
  readonly territory: number;
  readonly building: BuildingType;
}

export interface UpgradeCommand extends CommandEnvelope {
  readonly territory: number;
}

export interface DemolishCommand extends CommandEnvelope {
  readonly territory: number;
}

/* -------------------------------------------------------------------------- */
/* Navy                                                                        */
/* -------------------------------------------------------------------------- */

export interface BuildShipCommand extends CommandEnvelope {
  /** Territory holding the Port that will lay down the hull. */
  readonly portTerritory: number;
  readonly shipType: ShipType;
}

export interface MoveShipCommand extends CommandEnvelope {
  readonly shipId: number;
  /** Destination water territory. Pathfinding is server-side. */
  readonly destination: number;
}

export interface LoadTransportCommand extends CommandEnvelope {
  readonly shipId: number;
  /** Coastal territory to draw troops from. */
  readonly territory: number;
  readonly ratio: number;
}

export interface UnloadTransportCommand extends CommandEnvelope {
  readonly shipId: number;
  /** Coastal land territory to land on. Resolves as an attack if hostile. */
  readonly territory: number;
}

/* -------------------------------------------------------------------------- */
/* Missiles                                                                    */
/* -------------------------------------------------------------------------- */

export interface BuildMissileCommand extends CommandEnvelope {
  readonly siloTerritory: number;
  readonly missileType: MissileType;
}

export interface LaunchMissileCommand extends CommandEnvelope {
  readonly siloTerritory: number;
  readonly missileType: MissileType;
  /**
   * Target as world coordinates rather than a territory id: nuclear blasts have
   * an area of effect, so aiming between two cells is a legitimate and skilful
   * choice that a territory-id target would make impossible to express.
   */
  readonly targetX: number;
  readonly targetY: number;
}

/* -------------------------------------------------------------------------- */
/* Diplomacy & trade                                                           */
/* -------------------------------------------------------------------------- */

export interface AllianceInviteCommand extends CommandEnvelope {
  readonly targetSlot: number;
}

export interface AllianceRespondCommand extends CommandEnvelope {
  readonly fromSlot: number;
  readonly accept: boolean;
}

export interface AllianceLeaveCommand extends CommandEnvelope {
  /** Populated only when the leader kicks someone; otherwise the sender leaves. */
  readonly kickSlot?: number;
}

export interface DeclareWarCommand extends CommandEnvelope {
  readonly targetSlot: number;
}

export interface TradeCommand extends CommandEnvelope {
  readonly targetSlot: number;
  readonly gold: number;
  readonly food: number;
  /** A loan is recorded and auto-collected with interest after the term. */
  readonly asLoan: boolean;
}

/* -------------------------------------------------------------------------- */
/* Chat                                                                        */
/* -------------------------------------------------------------------------- */

export interface ChatCommand extends CommandEnvelope {
  readonly channel: ChatChannel;
  readonly text: string;
  /** Required when `channel` is `Private`. */
  readonly targetSlot?: number;
}

/* -------------------------------------------------------------------------- */
/* Acknowledgements                                                            */
/* -------------------------------------------------------------------------- */

export interface CommandAck {
  readonly seq: number;
  readonly ok: true;
}

export interface CommandReject {
  readonly seq: number;
  readonly ok: false;
  /** A {@link RejectReason} value. The client maps it to localised text. */
  readonly reason: number;
}

export type CommandResponse = CommandAck | CommandReject;
