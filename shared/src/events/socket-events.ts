import type {
  AllianceInviteCommand,
  AllianceLeaveCommand,
  AllianceRespondCommand,
  AttackCommand,
  BuildCommand,
  BuildMissileCommand,
  BuildShipCommand,
  ChatCommand,
  CommandResponse,
  DeclareWarCommand,
  DemolishCommand,
  JoinMatchCommand,
  LaunchMissileCommand,
  LeaveMatchCommand,
  LoadTransportCommand,
  MobiliseCommand,
  MoveShipCommand,
  TradeCommand,
  TransferTroopsCommand,
  UnloadTransportCommand,
  UpgradeCommand,
} from '../packets/commands.js';
import type {
  AllianceUpdatePacket,
  BuildingCompletedEvent,
  ChatPacket,
  CombatResolvedEvent,
  LeaderboardPacket,
  MatchEndedPacket,
  MatchInitPacket,
  MissileImpactEvent,
  MissileLaunchedEvent,
  PlayerEliminatedEvent,
  PlayerListPacket,
  ResourceUpdatePacket,
  SystemNoticePacket,
  TerritoryCapturedEvent,
  TerritoryDetailPacket,
  WorldDeltaPacket,
  WorldSnapshotPacket,
} from '../packets/updates.js';

/**
 * The complete Socket.IO surface, expressed as two interfaces.
 *
 * Socket.IO is generic over these maps, so `io.emit('world:delta', payload)` is
 * type-checked on the server and `socket.on('world:delta', (payload) => ...)`
 * is inferred on the client — from the *same* declaration. Adding a field to a
 * packet without updating the consumer becomes a compile error rather than a
 * runtime `undefined` that surfaces as a rendering glitch three weeks later.
 *
 * Naming convention: `domain:action`, lower-case. The prefix lets middleware
 * route by domain (e.g. apply the chat rate-limit bucket to everything under
 * `chat:`) without maintaining a separate list of event names.
 */

/* -------------------------------------------------------------------------- */
/* Client → server                                                             */
/* -------------------------------------------------------------------------- */

export interface ClientToServerEvents {
  /* Session -------------------------------------------------------------- */
  'match:join': (
    cmd: JoinMatchCommand,
    ack: (res: MatchInitPacket | CommandResponse) => void,
  ) => void;
  'match:leave': (cmd: LeaveMatchCommand) => void;
  /** Requests a fresh keyframe after the client detects a delta gap. */
  'match:resync': () => void;
  /** Round-trip latency probe. The server echoes the client's timestamp. */
  'net:ping': (clientTime: number, ack: (serverTime: number, echoed: number) => void) => void;

  /* Military -------------------------------------------------------------- */
  'cmd:attack': (cmd: AttackCommand) => void;
  'cmd:transfer': (cmd: TransferTroopsCommand) => void;
  'cmd:mobilise': (cmd: MobiliseCommand) => void;

  /* Construction ---------------------------------------------------------- */
  'cmd:build': (cmd: BuildCommand) => void;
  'cmd:upgrade': (cmd: UpgradeCommand) => void;
  'cmd:demolish': (cmd: DemolishCommand) => void;

  /* Navy ------------------------------------------------------------------ */
  'cmd:ship-build': (cmd: BuildShipCommand) => void;
  'cmd:ship-move': (cmd: MoveShipCommand) => void;
  'cmd:ship-load': (cmd: LoadTransportCommand) => void;
  'cmd:ship-unload': (cmd: UnloadTransportCommand) => void;

  /* Missiles -------------------------------------------------------------- */
  'cmd:missile-build': (cmd: BuildMissileCommand) => void;
  'cmd:missile-launch': (cmd: LaunchMissileCommand) => void;

  /* Diplomacy ------------------------------------------------------------- */
  'cmd:alliance-invite': (cmd: AllianceInviteCommand) => void;
  'cmd:alliance-respond': (cmd: AllianceRespondCommand) => void;
  'cmd:alliance-leave': (cmd: AllianceLeaveCommand) => void;
  'cmd:declare-war': (cmd: DeclareWarCommand) => void;
  'cmd:trade': (cmd: TradeCommand) => void;

  /* Chat ------------------------------------------------------------------ */
  'chat:send': (cmd: ChatCommand) => void;

  /* Queries --------------------------------------------------------------- */
  'query:territory': (
    territoryId: number,
    ack: (res: TerritoryDetailPacket | null) => void,
  ) => void;
}

/* -------------------------------------------------------------------------- */
/* Server → client                                                             */
/* -------------------------------------------------------------------------- */

export interface ServerToClientEvents {
  /* Session --------------------------------------------------------------- */
  'match:init': (packet: MatchInitPacket) => void;
  'match:ended': (packet: MatchEndedPacket) => void;
  'match:players': (packet: PlayerListPacket) => void;

  /* World state ----------------------------------------------------------- */
  'world:snapshot': (packet: WorldSnapshotPacket) => void;
  'world:delta': (packet: WorldDeltaPacket) => void;

  /* Player-scoped --------------------------------------------------------- */
  'player:resources': (packet: ResourceUpdatePacket) => void;
  'player:eliminated': (event: PlayerEliminatedEvent) => void;

  /* Discrete events ------------------------------------------------------- */
  'event:territory-captured': (event: TerritoryCapturedEvent) => void;
  'event:combat': (event: CombatResolvedEvent) => void;
  'event:missile-launched': (event: MissileLaunchedEvent) => void;
  'event:missile-impact': (event: MissileImpactEvent) => void;
  'event:building-completed': (event: BuildingCompletedEvent) => void;

  /* Social ---------------------------------------------------------------- */
  'alliance:update': (packet: AllianceUpdatePacket) => void;
  'leaderboard:update': (packet: LeaderboardPacket) => void;
  'chat:message': (packet: ChatPacket) => void;

  /* Feedback -------------------------------------------------------------- */
  /** Result of a specific command, keyed by the client's `seq`. */
  'cmd:response': (response: CommandResponse) => void;
  'system:notice': (packet: SystemNoticePacket) => void;
}

/* -------------------------------------------------------------------------- */
/* Server-internal                                                             */
/* -------------------------------------------------------------------------- */

/** Events between Socket.IO server nodes, once Redis adapter clustering lands. */
export interface InterServerEvents {
  'node:heartbeat': (nodeId: string, load: number) => void;
}

/** Per-connection state attached by the auth middleware. */
export interface SocketData {
  accountId: string;
  name: string;
  isGuest: boolean;
  /** Room id once joined; `null` while in the lobby. */
  roomId: string | null;
  /** Player slot in the joined room; `-1` for spectators. */
  slot: number;
  role: number;
  connectedAt: number;
}

/** Literal union of every client-sendable event name, for middleware routing. */
export type ClientEventName = keyof ClientToServerEvents;
export type ServerEventName = keyof ServerToClientEvents;
