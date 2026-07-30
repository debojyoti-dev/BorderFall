/**
 * Canonical rejection reasons for a client command.
 *
 * The server never explains a rejection in prose over the wire — it returns a
 * code, and the client maps it to a localised string. That keeps the rejection
 * path allocation-free on the hot server path and prevents leaking internal
 * state (e.g. an opponent's exact troop count) through error text.
 */
export const RejectReason = {
  Unknown: 0,

  /* --- Authorisation ------------------------------------------------------ */
  NotAuthenticated: 100,
  NotInMatch: 101,
  /** Spectators and eliminated players may not issue commands. */
  NotAPlayer: 102,
  MatchNotRunning: 103,
  RateLimited: 104,
  /** Payload failed schema validation — a malformed or spoofed packet. */
  MalformedPacket: 105,

  /* --- Territory & ownership --------------------------------------------- */
  UnknownTerritory: 200,
  NotOwner: 201,
  /** Source and target do not share an edge in the neighbour graph. */
  NotAdjacent: 202,
  /** Target is already yours. */
  AlreadyOwned: 203,
  /** Land command issued against water, or vice versa. */
  InvalidTerrain: 204,
  /** Attacking an ally is blocked until the alliance is broken. */
  TargetIsAlly: 205,
  /** Not enough troops staged in the source territory. */
  InsufficientTroops: 206,
  /** An attack from this territory is already resolving. */
  AttackInProgress: 207,

  /* --- Economy ------------------------------------------------------------ */
  InsufficientGold: 300,
  InsufficientFood: 301,
  InsufficientResources: 302,
  PopulationCapReached: 303,

  /* --- Buildings ---------------------------------------------------------- */
  BuildingAlreadyPresent: 400,
  BuildingMissing: 401,
  MaxLevelReached: 402,
  /** e.g. a Port on a territory with no adjacent sea tile. */
  InvalidBuildLocation: 403,
  /** Per-player cap for this structure reached. */
  BuildLimitReached: 404,
  UnderConstruction: 405,

  /* --- Military ----------------------------------------------------------- */
  CooldownActive: 500,
  OutOfRange: 501,
  NoSiloAvailable: 502,
  UnknownUnit: 503,
  InvalidPath: 504,

  /* --- Diplomacy & social ------------------------------------------------- */
  AlreadyAllied: 600,
  NotAllied: 601,
  AllianceFull: 602,
  NoPendingRequest: 603,
  SelfTargeted: 604,
  PlayerNotFound: 605,
  Muted: 606,
  MessageTooLong: 607,
} as const;

export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];

/** Developer-facing descriptions. The client ships its own localised table. */
export const REJECT_REASON_TEXT: Readonly<Record<number, string>> = {
  [RejectReason.Unknown]: 'The action could not be completed.',
  [RejectReason.NotAuthenticated]: 'You are not signed in.',
  [RejectReason.NotInMatch]: 'You are not in this match.',
  [RejectReason.NotAPlayer]: 'Spectators cannot perform this action.',
  [RejectReason.MatchNotRunning]: 'The match is not running.',
  [RejectReason.RateLimited]: 'You are acting too quickly.',
  [RejectReason.MalformedPacket]: 'Malformed request.',
  [RejectReason.UnknownTerritory]: 'That territory does not exist.',
  [RejectReason.NotOwner]: 'You do not control that territory.',
  [RejectReason.NotAdjacent]: 'Those territories do not border each other.',
  [RejectReason.AlreadyOwned]: 'You already control that territory.',
  [RejectReason.InvalidTerrain]: 'That terrain does not permit this action.',
  [RejectReason.TargetIsAlly]: 'You cannot attack an ally.',
  [RejectReason.InsufficientTroops]: 'Not enough troops.',
  [RejectReason.AttackInProgress]: 'An attack is already under way from there.',
  [RejectReason.InsufficientGold]: 'Not enough gold.',
  [RejectReason.InsufficientFood]: 'Not enough food.',
  [RejectReason.InsufficientResources]: 'Not enough resources.',
  [RejectReason.PopulationCapReached]: 'Population cap reached.',
  [RejectReason.BuildingAlreadyPresent]: 'There is already a building here.',
  [RejectReason.BuildingMissing]: 'There is no building here.',
  [RejectReason.MaxLevelReached]: 'This building is fully upgraded.',
  [RejectReason.InvalidBuildLocation]: 'This building cannot be placed here.',
  [RejectReason.BuildLimitReached]: 'You have reached the limit for this building.',
  [RejectReason.UnderConstruction]: 'Construction is still in progress.',
  [RejectReason.CooldownActive]: 'That ability is on cooldown.',
  [RejectReason.OutOfRange]: 'Target is out of range.',
  [RejectReason.NoSiloAvailable]: 'You have no available missile silo.',
  [RejectReason.UnknownUnit]: 'That unit no longer exists.',
  [RejectReason.InvalidPath]: 'No valid route to the destination.',
  [RejectReason.AlreadyAllied]: 'You are already allied.',
  [RejectReason.NotAllied]: 'You are not allied with that player.',
  [RejectReason.AllianceFull]: 'That alliance is full.',
  [RejectReason.NoPendingRequest]: 'There is no pending request.',
  [RejectReason.SelfTargeted]: 'You cannot target yourself.',
  [RejectReason.PlayerNotFound]: 'Player not found.',
  [RejectReason.Muted]: 'You are muted.',
  [RejectReason.MessageTooLong]: 'Message is too long.',
};
