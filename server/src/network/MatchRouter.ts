import {
  ConnectionRole,
  MatchState,
  RejectReason,
  isValidPlayerName,
  sanitisePlayerName,
  type AttackCommand,
  type CommandResponse,
  type JoinMatchCommand,
  type MatchInitPacket,
  type TransferTroopsCommand,
} from '@borderfall/shared';
import type { MatchInstance } from '../match/MatchInstance.js';
import type { MatchManager } from '../match/MatchManager.js';
import type { Player } from '../match/PlayerRegistry.js';
import {
  applyTransfer,
  resolveAttack,
  validateAttack,
  validateTransfer,
  type CooldownMap,
} from '../match/commands.js';
import { verifyToken } from '../services/auth.js';
import { createLogger } from '../utils/logger.js';
import { Metric, metrics } from '../services/metrics.js';
import { encodeSnapshot } from './StateEncoder.js';
import { StateBroadcaster } from './StateBroadcaster.js';
import type { ConnectionHandler, GameServer, GameSocket, SocketGateway } from './SocketGateway.js';

const log = createLogger('router');

/**
 * Routes socket events to matches.
 *
 * Holds the per-match broadcaster and per-territory cooldowns, and enforces the
 * ordering that makes the server authoritative: authenticate → rate-limit →
 * validate → mutate → acknowledge. A command that fails any earlier step never
 * reaches the world.
 */
export class MatchRouter implements ConnectionHandler {
  private readonly broadcasters = new Map<string, StateBroadcaster>();
  /** Attack cooldowns per match, keyed by territory id. */
  private readonly cooldowns = new Map<string, CooldownMap>();

  constructor(private readonly matches: MatchManager) {}

  onConnect(socket: GameSocket, gateway: SocketGateway): void {
    /**
     * Authenticate from the handshake.
     *
     * Identity is resolved once, at connect, rather than per command. A command
     * handler that re-read a client-supplied identity would be trusting the
     * client with the single most security-critical value in the system.
     */
    const token = socket.handshake.auth['token'];
    if (typeof token === 'string' && token.length > 0) {
      const identity = verifyToken(token);
      if (identity) {
        socket.data.accountId = identity.accountId;
        socket.data.name = identity.name;
        socket.data.isGuest = identity.isGuest;
      }
    }

    socket.on('match:join', (command, ack) => {
      this.handleJoin(socket, command, ack);
    });

    socket.on('match:leave', (command) => {
      this.handleLeave(socket, command.surrender === true);
    });

    socket.on('match:resync', () => {
      const match = this.matchFor(socket);
      if (!match) return;
      this.broadcasterFor(match).sendSnapshotTo(socket.id);
    });

    socket.on('cmd:attack', (command) => {
      this.handleAttack(socket, gateway, command);
    });

    socket.on('cmd:transfer', (command) => {
      this.handleTransfer(socket, gateway, command);
    });

    socket.on('query:territory', (territoryId, ack) => {
      const match = this.matchFor(socket);
      if (!match || typeof ack !== 'function') return;
      if (!match.reader.isValidId(territoryId)) {
        ack(null);
        return;
      }
      ack({
        territory: {
          id: territoryId,
          owner: match.world.getOwner(territoryId),
          population: match.world.population[territoryId] as number,
          troops: match.world.troops[territoryId] as number,
          building: match.world.building[territoryId] as never,
          buildingLevel: match.world.buildingLevel[territoryId] as number,
          buildingHp: 0,
          constructionProgress: (match.world.construction[territoryId] as number) / 255,
          contested: false,
        },
      });
    });
  }

  onDisconnect(socket: GameSocket, reason: string): void {
    const match = this.matchFor(socket);
    if (!match) return;

    const player = match.players.markDisconnected(socket.id, Date.now());
    if (!player) return;

    log.info('Player disconnected', {
      match: match.code,
      slot: player.slot,
      reason,
    });

    // Territories are retained for the grace period — see PlayerRegistry.
    match.bus.emit('player:disconnected', {
      slot: player.slot,
      graceExpiresAt: player.graceExpiresAt,
    });
    this.broadcasterFor(match).broadcastPlayerList();
    metrics.setGauge(Metric.playersActive, Math.max(0, metrics.getGauge(Metric.playersActive) - 1));
  }

  /* ---------------------------------------------------------------------- */
  /* Join / leave                                                            */
  /* ---------------------------------------------------------------------- */

  private handleJoin(
    socket: GameSocket,
    command: JoinMatchCommand,
    ack: (response: MatchInitPacket | CommandResponse) => void,
  ): void {
    const respond = typeof ack === 'function' ? ack : () => {};
    const seq = typeof command?.seq === 'number' ? command.seq : 0;

    if (socket.data.roomId !== null) {
      respond({ seq, ok: false, reason: RejectReason.Unknown });
      return;
    }

    const match =
      typeof command?.roomId === 'string' && command.roomId.length > 0
        ? this.matches.resolve(command.roomId)
        : this.matches.findOrCreatePublic();

    if (!match) {
      respond({ seq, ok: false, reason: RejectReason.PlayerNotFound });
      return;
    }

    // Password is compared server-side and never echoed back, so a wrong guess
    // reveals nothing beyond "wrong".
    const required = match.config.password;
    if (typeof required === 'string' && required.length > 0) {
      if (command.password !== required) {
        respond({ seq, ok: false, reason: RejectReason.NotAuthenticated });
        return;
      }
    }

    let player: Player | null = null;

    // Reconnect first: a returning player must reclaim their empire rather than
    // be seated as somebody new.
    if (typeof command.reconnectToken === 'string' && command.reconnectToken.length > 0) {
      player = match.players.reconnect(command.reconnectToken, socket.id);
      if (player) {
        log.info('Player reconnected', { match: match.code, slot: player.slot });
        match.bus.emit('player:reconnected', { slot: player.slot });
      }
    }

    if (!player) {
      if (match.matchState === MatchState.Finished) {
        respond({ seq, ok: false, reason: RejectReason.MatchNotRunning });
        return;
      }
      if (!match.hasCapacity) {
        respond({ seq, ok: false, reason: RejectReason.AllianceFull });
        return;
      }

      const requested = sanitisePlayerName(socket.data.name ?? '');
      const name = isValidPlayerName(requested)
        ? requested
        : `Player${Math.floor(Math.random() * 9000) + 1000}`;
      const accountId = socket.data.accountId ?? `anon:${socket.id}`;

      player = match.addPlayer(accountId, name, false);
      if (!player) {
        respond({ seq, ok: false, reason: RejectReason.AllianceFull });
        return;
      }
      match.players.bindSocket(player.slot, socket.id);
    }

    socket.data.roomId = match.id;
    socket.data.slot = player.slot;
    socket.data.role = ConnectionRole.Player;
    void socket.join(`match:${match.id}`);

    // Start on first join rather than on a timer: an empty match burning a
    // 50 ms interval for nobody is pure waste at scale.
    if (match.matchState === MatchState.Lobby) {
      match.start();
    }
    this.broadcasterFor(match).start();

    const now = Date.now();
    respond({
      roomId: match.id,
      matchId: match.id,
      // The map itself is never sent — only the parameters needed to rebuild it.
      mapParams: match.mapParams,
      yourSlot: player.slot,
      reconnectToken: player.reconnectToken,
      players: match.players.toViews(),
      alliances: [],
      serverTime: now,
      tick: match.tick,
      snapshot: encodeSnapshot(match.world, match.tick, now),
    } satisfies MatchInitPacket);

    // Roster and standings are pushed immediately rather than waiting for the
    // next periodic tick, so a joining player never sees empty panels.
    this.broadcasterFor(match).broadcastPlayerList();
    this.broadcasterFor(match).broadcastLeaderboard();

    metrics.setGauge(Metric.playersActive, metrics.getGauge(Metric.playersActive) + 1);
    log.info('Player joined', { match: match.code, slot: player.slot, name: player.name });
  }

  private handleLeave(socket: GameSocket, surrender: boolean): void {
    const match = this.matchFor(socket);
    if (!match) return;

    const slot = socket.data.slot;
    if (slot >= 0) match.removePlayer(slot, surrender);

    void socket.leave(`match:${match.id}`);
    socket.data.roomId = null;
    socket.data.slot = -1;

    this.broadcasterFor(match).broadcastPlayerList();
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ---------------------------------------------------------------------- */

  private handleAttack(socket: GameSocket, gateway: SocketGateway, command: AttackCommand): void {
    const context = this.playerContext(socket);
    if (!context) return;
    const { match, player } = context;

    metrics.increment(Metric.commandsReceived);

    // Rate limit before validation: the limiter exists to make a flood cheap to
    // reject, which it cannot do if validation runs first.
    if (!gateway.consumeToken(socket, 'command')) {
      this.reject(socket, command?.seq ?? 0, RejectReason.RateLimited);
      return;
    }

    const now = Date.now();
    const cooldowns = this.cooldownsFor(match);
    const validated = validateAttack(match, player, command, cooldowns, now);

    if (!validated.ok) {
      this.reject(socket, command?.seq ?? 0, validated.reason);
      return;
    }

    const { from, to, troops } = validated.value;
    cooldowns.set(from, now + 500);

    // The roll comes from the match's simulation RNG, never from the client,
    // and never from Math.random — replays must reproduce this exactly.
    resolveAttack(match, player, from, to, troops, Math.random());

    this.ack(socket, command.seq);
  }

  private handleTransfer(
    socket: GameSocket,
    gateway: SocketGateway,
    command: TransferTroopsCommand,
  ): void {
    const context = this.playerContext(socket);
    if (!context) return;
    const { match, player } = context;

    metrics.increment(Metric.commandsReceived);

    if (!gateway.consumeToken(socket, 'command')) {
      this.reject(socket, command?.seq ?? 0, RejectReason.RateLimited);
      return;
    }

    const validated = validateTransfer(match, player, command);
    if (!validated.ok) {
      this.reject(socket, command?.seq ?? 0, validated.reason);
      return;
    }

    applyTransfer(match, validated.value.from, validated.value.to, validated.value.troops);
    this.ack(socket, command.seq);
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  private playerContext(socket: GameSocket): { match: MatchInstance; player: Player } | null {
    const match = this.matchFor(socket);
    if (!match) return null;
    // Spectators hold a role but no slot, so this rejects them implicitly.
    if (socket.data.role !== ConnectionRole.Player) return null;

    const player = match.players.getBySocket(socket.id);
    if (!player) return null;

    return { match, player };
  }

  private matchFor(socket: GameSocket): MatchInstance | undefined {
    const roomId = socket.data.roomId;
    return roomId === null ? undefined : this.matches.getById(roomId);
  }

  private broadcasterFor(match: MatchInstance): StateBroadcaster {
    let broadcaster = this.broadcasters.get(match.id);
    if (!broadcaster) {
      broadcaster = new StateBroadcaster(this.io, match);
      this.broadcasters.set(match.id, broadcaster);
    }
    return broadcaster;
  }

  private cooldownsFor(match: MatchInstance): CooldownMap {
    let map = this.cooldowns.get(match.id);
    if (!map) {
      map = new Map<number, number>();
      this.cooldowns.set(match.id, map);
    }
    return map;
  }

  private ack(socket: GameSocket, seq: number): void {
    socket.emit('cmd:response', { seq, ok: true });
  }

  private reject(socket: GameSocket, seq: number, reason: RejectReason): void {
    metrics.increment(Metric.commandsRejected);
    socket.emit('cmd:response', { seq, ok: false, reason });
  }

  /** Assigned by {@link attach}; the router needs the server to build broadcasters. */
  private io!: GameServer;

  attach(gateway: SocketGateway): void {
    this.io = gateway.server;
    gateway.use(this);
  }

  /** Stops every broadcaster. Called during shutdown. */
  dispose(): void {
    for (const broadcaster of this.broadcasters.values()) broadcaster.stop();
    this.broadcasters.clear();
    this.cooldowns.clear();
  }
}
