import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  MAX_PACKET_BYTES,
  RATE_LIMITS,
  TokenBucket,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from '@borderfall/shared';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { Metric, metrics } from '../services/metrics.js';

const log = createLogger('gateway');

export type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type GameServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** Per-connection state the gateway owns, keyed by socket id. */
interface ConnectionState {
  readonly commandBucket: TokenBucket;
  readonly chatBucket: TokenBucket;
  readonly diplomacyBucket: TokenBucket;
}

/**
 * Registered by feature modules to attach their own event handlers.
 *
 * The gateway owns transport concerns only — rate limits, packet size,
 * connection accounting — and knows nothing about matches. Feature routing is
 * layered on through this hook, which keeps the abuse-prevention layer
 * impossible to bypass from game code and keeps the gateway testable without
 * constructing a match.
 */
export interface ConnectionHandler {
  onConnect(socket: GameSocket, gateway: SocketGateway): void;
  onDisconnect(socket: GameSocket, reason: string): void;
}

/**
 * Owns the Socket.IO server and everything that is true of *every* connection,
 * regardless of which match it belongs to: transport configuration, rate
 * limiting, packet-size guards, latency probes and connection accounting.
 *
 * Match-specific routing is deliberately not here — that arrives in Phase 3 as
 * a room registry that this gateway delegates to. Keeping the two apart means
 * the abuse-prevention layer cannot be bypassed by a bug in match logic, and it
 * stays testable without constructing a match.
 */
export class SocketGateway {
  private readonly io: GameServer;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly handlers: ConnectionHandler[] = [];

  constructor(httpServer: HttpServer) {
    this.io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
      httpServer,
      {
        cors: {
          origin: env.corsOrigins,
          credentials: true,
        },
        /**
         * WebSocket only. Long-polling would let a client fall back to a
         * transport with 200 ms+ effective latency, which for a real-time RTS is
         * worse than a clear connection failure the player can act on.
         */
        transports: ['websocket'],
        /**
         * The server pings; a client that misses two intervals is dropped. Tuned
         * short so a dropped player's territories become contestable quickly,
         * but long enough to survive a mobile network hiccup.
         */
        pingInterval: 10_000,
        pingTimeout: 12_000,
        maxHttpBufferSize: MAX_PACKET_BYTES,
        /** Deltas are small and frequent; compression costs more CPU than it saves. */
        perMessageDeflate: false,
        connectionStateRecovery: {
          // Socket.IO replays missed packets after a brief drop. Our own
          // reconnect-token flow handles longer outages and slot reclamation.
          maxDisconnectionDuration: 15_000,
          skipMiddlewares: false,
        },
      },
    );

    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: GameSocket): void {
    const now = Date.now();

    socket.data.roomId = null;
    socket.data.slot = -1;
    socket.data.connectedAt = now;

    this.connections.set(socket.id, {
      commandBucket: new TokenBucket(RATE_LIMITS.command, now),
      chatBucket: new TokenBucket(RATE_LIMITS.chat, now),
      diplomacyBucket: new TokenBucket(RATE_LIMITS.diplomacy, now),
    });

    metrics.increment(Metric.socketConnections);
    metrics.setGauge(Metric.socketsActive, this.connections.size);
    log.debug('Socket connected', { socketId: socket.id, active: this.connections.size });

    /**
     * Latency probe. The client sends its own clock, the server echoes it back
     * alongside the server clock. From those three timestamps the client
     * derives both round-trip time and clock offset, which is what drives
     * snapshot interpolation — without an accurate offset the client either
     * renders in the past (laggy) or extrapolates into the future (jittery).
     */
    socket.on('net:ping', (clientTime, ack) => {
      if (typeof ack === 'function') ack(Date.now(), clientTime);
    });

    socket.on('disconnect', (reason) => {
      // Feature handlers run before the connection record is dropped, so they
      // can still read the socket's slot and room while cleaning up.
      for (const handler of this.handlers) {
        try {
          handler.onDisconnect(socket, reason);
        } catch (error) {
          log.error('Disconnect handler threw', {
            socketId: socket.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.connections.delete(socket.id);
      metrics.increment(Metric.socketDisconnections);
      metrics.setGauge(Metric.socketsActive, this.connections.size);
      log.debug('Socket disconnected', {
        socketId: socket.id,
        reason,
        lifetimeMs: Date.now() - socket.data.connectedAt,
      });
    });

    for (const handler of this.handlers) {
      try {
        handler.onConnect(socket, this);
      } catch (error) {
        log.error('Connect handler threw', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Registers a feature module's per-connection handlers. */
  use(handler: ConnectionHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Consumes a rate-limit token for a connection.
   *
   * Returns false when the client is over budget; the caller rejects the
   * command. Separate buckets mean chat spam cannot starve a player's ability
   * to issue attack orders, and an invite-spammer cannot exhaust their own
   * gameplay budget as a side effect.
   */
  consumeToken(socket: GameSocket, kind: keyof typeof RATE_LIMITS, nowMs = Date.now()): boolean {
    const state = this.connections.get(socket.id);
    if (!state) return false;

    const bucket =
      kind === 'chat'
        ? state.chatBucket
        : kind === 'diplomacy'
          ? state.diplomacyBucket
          : state.commandBucket;

    if (bucket.tryConsume(nowMs)) return true;

    metrics.increment(Metric.commandsRejected);
    return false;
  }

  get server(): GameServer {
    return this.io;
  }

  get activeConnections(): number {
    return this.connections.size;
  }

  /** Stops accepting connections and closes existing ones. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.io.close(() => resolve());
    });
    this.connections.clear();
    metrics.setGauge(Metric.socketsActive, 0);
  }
}
