import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@borderfall/shared';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export interface NetworkQuality {
  /** Smoothed round-trip time in ms. */
  latencyMs: number;
  /**
   * `serverNow - clientNow`, in ms.
   *
   * Every timestamp the server sends is on *its* clock. Without this offset the
   * client cannot place a snapshot on its own timeline, and interpolation
   * either lags or overshoots by however far the two clocks differ — which on
   * a typical machine is seconds, not milliseconds.
   */
  clockOffsetMs: number;
  /** Round-trip variance; a proxy for connection stability. */
  jitterMs: number;
}

export interface SocketClientOptions {
  url?: string;
  /** How often to probe latency. */
  pingIntervalMs?: number;
  onStatusChange?: (status: ConnectionStatus) => void;
  onQualityChange?: (quality: NetworkQuality) => void;
}

/**
 * Thin, typed wrapper around the Socket.IO client.
 *
 * It owns three things React should never touch directly:
 *
 * 1. **Connection lifecycle** — a single socket for the app's lifetime, created
 *    outside React so that a re-render, a Strict-Mode double-mount or a route
 *    change can never tear down a live game connection.
 * 2. **Clock synchronisation** — see {@link NetworkQuality.clockOffsetMs}.
 * 3. **Command sequencing** — allocates the `seq` every command carries, so the
 *    UI can correlate a rejection with the button that caused it.
 *
 * Deliberately *not* a React hook. Hooks are for reading this state; owning a
 * long-lived connection inside one invites subtle lifecycle bugs.
 */
export class SocketClient {
  private socket: ClientSocket | null = null;
  private status: ConnectionStatus = 'idle';

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pingIntervalMs: number;
  private readonly url: string;

  private commandSeq = 0;

  /**
   * Recent RTT samples.
   *
   * A rolling median rather than a running average: latency samples are spiky,
   * and a single 800 ms outlier from a GC pause would drag an average enough to
   * visibly shift the interpolation delay. The median ignores it entirely.
   */
  private readonly rttSamples: number[] = [];
  private static readonly RTT_WINDOW = 12;

  private quality: NetworkQuality = { latencyMs: 0, clockOffsetMs: 0, jitterMs: 0 };

  constructor(private readonly options: SocketClientOptions = {}) {
    this.url = options.url ?? '';
    this.pingIntervalMs = options.pingIntervalMs ?? 2000;
  }

  connect(auth?: Record<string, string>): ClientSocket {
    if (this.socket?.connected) return this.socket;

    this.setStatus('connecting');

    this.socket = io(this.url, {
      // Must match the server: no polling fallback.
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      /**
       * Exponential backoff with jitter. Without randomisation, every client
       * disconnected by a server restart reconnects in lockstep and delivers a
       * thundering herd to a process that has just finished booting.
       */
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
      timeout: 10_000,
      auth: auth ?? {},
    }) as ClientSocket;

    this.socket.on('connect', () => {
      this.setStatus('connected');
      this.startPinging();
    });

    this.socket.on('disconnect', (reason) => {
      this.stopPinging();
      // An explicit server-side or client-side disconnect will not retry;
      // anything else is transport loss and Socket.IO will reconnect for us.
      this.setStatus(
        reason === 'io server disconnect' || reason === 'io client disconnect'
          ? 'disconnected'
          : 'reconnecting',
      );
    });

    this.socket.io.on('reconnect_attempt', () => this.setStatus('reconnecting'));
    this.socket.io.on('reconnect_failed', () => this.setStatus('failed'));

    return this.socket;
  }

  disconnect(): void {
    this.stopPinging();
    this.socket?.disconnect();
    this.socket = null;
    this.rttSamples.length = 0;
    this.setStatus('idle');
  }

  /** Next sequence number for a command envelope. */
  nextSeq(): number {
    return ++this.commandSeq;
  }

  get raw(): ClientSocket | null {
    return this.socket;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get networkQuality(): NetworkQuality {
    return this.quality;
  }

  /** Converts a server timestamp into the client's own clock domain. */
  toClientTime(serverTime: number): number {
    return serverTime - this.quality.clockOffsetMs;
  }

  /** Current server time as best the client can estimate it. */
  estimatedServerTime(): number {
    return Date.now() + this.quality.clockOffsetMs;
  }

  private startPinging(): void {
    this.stopPinging();
    this.probe();
    this.pingTimer = setInterval(() => this.probe(), this.pingIntervalMs);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private probe(): void {
    const socket = this.socket;
    if (!socket?.connected) return;

    const sentAt = Date.now();
    socket.emit('net:ping', sentAt, (serverTime: number, echoed: number) => {
      // Guard against a stale ack arriving after a reconnect.
      if (echoed !== sentAt) return;

      const receivedAt = Date.now();
      const rtt = receivedAt - sentAt;
      this.recordRtt(rtt);

      /**
       * Assume the request and response legs are symmetric, so the server's
       * clock read corresponds to `sentAt + rtt / 2` on our clock. That
       * assumption is wrong under asymmetric routing, but the error is bounded
       * by the asymmetry and the median across samples absorbs most of it.
       */
      const estimatedClientTimeAtServer = sentAt + rtt / 2;
      const offset = serverTime - estimatedClientTimeAtServer;

      const latency = this.medianRtt();
      this.quality = {
        latencyMs: Math.round(latency),
        // Smooth the offset heavily: it should drift slowly, and a jumpy offset
        // produces visible stutter in interpolated positions.
        clockOffsetMs:
          this.quality.clockOffsetMs === 0
            ? offset
            : this.quality.clockOffsetMs * 0.9 + offset * 0.1,
        jitterMs: Math.round(this.computeJitter()),
      };
      this.options.onQualityChange?.(this.quality);
    });
  }

  private recordRtt(rtt: number): void {
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > SocketClient.RTT_WINDOW) this.rttSamples.shift();
  }

  private medianRtt(): number {
    if (this.rttSamples.length === 0) return 0;
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number);
  }

  private computeJitter(): number {
    if (this.rttSamples.length < 2) return 0;
    const mean = this.rttSamples.reduce((sum, value) => sum + value, 0) / this.rttSamples.length;
    const variance =
      this.rttSamples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / this.rttSamples.length;
    return Math.sqrt(variance);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
