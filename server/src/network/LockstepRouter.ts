import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  MAX_PACKET_BYTES,
  RATE_LIMITS,
  TokenBucket,
  generateRoomCode,
  isValidPlayerName,
  sanitisePlayerName,
  type ChecksumReport,
  type Intent,
  type LockstepClientToServerEvents,
  type LockstepServerToClientEvents,
  type LockstepStartPacket,
} from '@borderfall/shared';
import { env } from '../config/env.js';
import { LockstepMatch } from '../match/LockstepMatch.js';
import { verifyToken } from '../services/auth.js';
import { createLogger } from '../utils/logger.js';
import { Metric, metrics } from '../services/metrics.js';

const log = createLogger('lockstep');

interface SocketState {
  accountId: string;
  name: string;
  matchId: string | null;
  slot: number;
  bucket: TokenBucket;
}

type LockstepSocket = Socket<LockstepClientToServerEvents, LockstepServerToClientEvents>;

/**
 * The lockstep transport.
 *
 * The server's entire job in this architecture: authenticate a connection, put
 * it in a room, stamp its intents with its slot, and broadcast turn bundles.
 * There is no world here, no validation of gameplay, and no state to
 * synchronise.
 *
 * Rate limiting still matters, and arguably more than before. A relay cannot
 * reject an intent as illegal, so the only defence against a client flooding
 * the match with intents — which every peer would then have to apply — is to
 * cap submission rate at the edge.
 */
export class LockstepRouter {
  private readonly io: Server<LockstepClientToServerEvents, LockstepServerToClientEvents>;
  private readonly matches = new Map<string, LockstepMatch>();
  private readonly byCode = new Map<string, LockstepMatch>();
  private readonly sockets = new Map<string, SocketState>();

  /**
   * @param path Socket.IO mount point. Defaults to `/lockstep/` so the relay
   * can run alongside the server-authoritative gateway during the transition;
   * the two attach to the same HTTP server on different paths.
   */
  constructor(httpServer: HttpServer, path = '/lockstep/') {
    this.io = new Server(httpServer, {
      path,
      cors: { origin: env.corsOrigins, credentials: true },
      transports: ['websocket'],
      pingInterval: 10_000,
      pingTimeout: 12_000,
      maxHttpBufferSize: MAX_PACKET_BYTES,
      perMessageDeflate: false,
    });

    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: LockstepSocket): void {
    const token = socket.handshake.auth['token'];
    const identity = typeof token === 'string' ? verifyToken(token) : null;

    const state: SocketState = {
      accountId: identity?.accountId ?? `anon:${socket.id}`,
      name: identity?.name ?? '',
      matchId: null,
      slot: -1,
      bucket: new TokenBucket(RATE_LIMITS.command, Date.now()),
    };
    this.sockets.set(socket.id, state);

    metrics.increment(Metric.socketConnections);
    metrics.setGauge(Metric.socketsActive, this.sockets.size);

    socket.on('lockstep:join', (request, ack) => this.handleJoin(socket, state, request, ack));
    socket.on('lockstep:intent', (intent) => this.handleIntent(socket, state, intent));
    socket.on('lockstep:checksum', (report) => this.handleChecksum(state, report));
    socket.on('lockstep:leave', () => this.handleLeave(socket, state));
    socket.on('disconnect', () => this.handleDisconnect(socket, state));
  }

  /* Join ------------------------------------------------------------------- */

  private handleJoin(
    socket: LockstepSocket,
    state: SocketState,
    request: { roomId?: string; reconnectToken?: string },
    ack: (response: LockstepStartPacket | { error: string }) => void,
  ): void {
    const respond = typeof ack === 'function' ? ack : () => {};

    if (state.matchId !== null) {
      respond({ error: 'already_in_match' });
      return;
    }

    const match =
      typeof request?.roomId === 'string' && request.roomId.length > 0
        ? (this.matches.get(request.roomId) ?? this.byCode.get(request.roomId.toUpperCase()))
        : this.findOrCreate();

    if (!match) {
      respond({ error: 'not_found' });
      return;
    }

    let player = null;
    if (typeof request?.reconnectToken === 'string' && request.reconnectToken.length > 0) {
      player = match.reconnect(request.reconnectToken, socket.id);
    }

    if (!player) {
      if (!match.hasCapacity) {
        respond({ error: 'full' });
        return;
      }
      const requested = sanitisePlayerName(state.name);
      const name = isValidPlayerName(requested)
        ? requested
        : `Player${Math.floor(Math.random() * 9000) + 1000}`;

      player = match.addPlayer(state.accountId, name, false);
      if (!player) {
        respond({ error: 'full' });
        return;
      }
      match.bindSocket(player.slot, socket.id);
    }

    state.matchId = match.id;
    state.slot = player.slot;
    void socket.join(match.id);

    // The relay only ticks while somebody is listening; an empty match burning
    // a timer for nobody is pure waste at scale.
    if (!match.isRunning) match.start();

    /**
     * The start packet is sent *before* the player is announced to others.
     *
     * A joining client must be able to place any turn it receives, and turns
     * begin arriving the moment it enters the room. Announcing first would
     * risk a turn landing before the client knows the seed.
     */
    respond(match.startPacketFor(player));

    this.io.to(match.id).emit('lockstep:players', match.playerInfo());
    metrics.setGauge(Metric.playersActive, metrics.getGauge(Metric.playersActive) + 1);

    log.info('Player joined', { match: match.code, slot: player.slot, turn: match.turn });
  }

  /* Intents ---------------------------------------------------------------- */

  private handleIntent(
    socket: LockstepSocket,
    state: SocketState,
    intent: Omit<Intent, 'slot'>,
  ): void {
    if (state.matchId === null || state.slot < 0) return;

    metrics.increment(Metric.commandsReceived);

    // The only defence a relay has against intent flooding: it cannot reject an
    // intent as illegal, so it must cap the rate at which they arrive.
    if (!state.bucket.tryConsume(Date.now())) {
      metrics.increment(Metric.commandsRejected);
      return;
    }

    const match = this.matches.get(state.matchId);
    if (!match) return;

    // The slot comes from the authenticated connection, never the payload.
    match.submitIntent(state.slot, intent);
  }

  private handleChecksum(state: SocketState, report: ChecksumReport): void {
    if (state.matchId === null || state.slot < 0) return;
    if (typeof report?.turn !== 'number' || typeof report?.checksum !== 'number') return;

    this.matches.get(state.matchId)?.reportChecksum(state.slot, report);
  }

  /* Leave ------------------------------------------------------------------ */

  private handleLeave(socket: LockstepSocket, state: SocketState): void {
    const match = state.matchId === null ? undefined : this.matches.get(state.matchId);
    if (!match) return;

    match.markDisconnected(socket.id);
    void socket.leave(match.id);
    state.matchId = null;
    state.slot = -1;

    this.io.to(match.id).emit('lockstep:players', match.playerInfo());
  }

  private handleDisconnect(socket: LockstepSocket, state: SocketState): void {
    if (state.matchId !== null) {
      const match = this.matches.get(state.matchId);
      if (match) {
        match.markDisconnected(socket.id);
        this.io.to(match.id).emit('lockstep:players', match.playerInfo());

        // No territory is released. There is none to release — every client's
        // simulation owns the world, and a disconnected empire simply stops
        // issuing intents until it is conquered or the player returns.
        if (match.connectedCount === 0) {
          match.stop();
          log.info('Relay idled; no clients remain', { match: match.code });
        }
      }
    }

    this.sockets.delete(socket.id);
    metrics.increment(Metric.socketDisconnections);
    metrics.setGauge(Metric.socketsActive, this.sockets.size);
    metrics.setGauge(Metric.playersActive, Math.max(0, metrics.getGauge(Metric.playersActive) - 1));
  }

  /* Match registry --------------------------------------------------------- */

  create(overrides: Parameters<typeof LockstepMatch.defaultConfig>[0] = {}): LockstepMatch {
    const config = LockstepMatch.defaultConfig(overrides);
    const code = this.allocateCode();

    const match = new LockstepMatch(config, code, {
      onTurn: (turn) => {
        // Volatile: a dropped turn is better than a delayed one. Clients that
        // miss one detect the gap and request history rather than stalling the
        // whole match waiting for a retransmit.
        this.io.to(match.id).emit('lockstep:turn', turn);
        metrics.increment(Metric.broadcastBytes, 8 + turn.intents.length * 24);
      },
      onDesync: (turn, divergentSlots, majorityChecksum) => {
        this.io.to(match.id).emit('lockstep:desync', { turn, divergentSlots, majorityChecksum });
      },
    });

    this.matches.set(match.id, match);
    this.byCode.set(code, match);
    metrics.setGauge(Metric.matchesActive, this.matches.size);
    return match;
  }

  /** Prefers the fullest joinable match; see the region-model note on why. */
  private findOrCreate(): LockstepMatch {
    let best: LockstepMatch | null = null;
    for (const match of this.matches.values()) {
      if (!match.hasCapacity) continue;
      if (!best || match.connectedCount > best.connectedCount) best = match;
    }
    return best ?? this.create();
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = generateRoomCode(Math.random);
      if (!this.byCode.has(code)) return code;
    }
    return generateRoomCode(Math.random, 10);
  }

  getMatch(id: string): LockstepMatch | undefined {
    return this.matches.get(id);
  }

  getByCode(code: string): LockstepMatch | undefined {
    return this.byCode.get(code.toUpperCase());
  }

  listMatches(): LockstepMatch[] {
    return [...this.matches.values()];
  }

  get server(): Server<LockstepClientToServerEvents, LockstepServerToClientEvents> {
    return this.io;
  }

  async close(): Promise<void> {
    for (const match of this.matches.values()) match.stop();
    this.matches.clear();
    this.byCode.clear();
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
  }
}
