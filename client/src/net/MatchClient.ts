import {
  OWNER_NONE,
  TerritoryField,
  decodeDelta,
  decodeSnapshot,
  generateWorld,
  type LeaderboardEntry,
  type MatchInitPacket,
  type PlayerResourcesView,
  type PlayerView,
  type WorldDeltaPacket,
  type WorldGeometry,
  type WorldSnapshotPacket,
} from '@borderfall/shared';
import type { SocketClient } from '../socket/SocketClient.js';

/**
 * Client-side mirror of the authoritative world.
 *
 * Holds the same structure-of-arrays the server does, updated by snapshots and
 * deltas. Nothing here is authoritative: every value is what the server last
 * said, and the client never modifies it in response to local input. Optimistic
 * prediction is deliberately absent — for territory conquest the round trip is
 * short enough that predicting a capture would show a flicker of a wrong colour
 * far more often than it would hide latency.
 */

export interface MatchClientCallbacks {
  onInit?(geometry: WorldGeometry, packet: MatchInitPacket): void;
  /** Fired after any state change, with the ids that actually changed. */
  onTerritoriesChanged?(ids: readonly number[]): void;
  onFullResync?(): void;
  onPlayers?(players: readonly PlayerView[]): void;
  onResources?(resources: PlayerResourcesView): void;
  onLeaderboard?(entries: readonly LeaderboardEntry[]): void;
  onCommandRejected?(seq: number, reason: number): void;
  onNotice?(text: string, severity: 'info' | 'warning' | 'error'): void;
}

export class MatchClient {
  /** Mirrored territory state. Sized once the world geometry is known. */
  owner = new Uint16Array(0);
  population = new Uint32Array(0);
  troops = new Uint32Array(0);
  building = new Uint8Array(0);
  buildingLevel = new Uint8Array(0);

  geometry: WorldGeometry | null = null;
  mySlot = -1;
  matchId: string | null = null;
  reconnectToken: string | null = null;

  /** Newest tick applied, used to detect a gap in the delta stream. */
  private lastTick = -1;
  private resyncRequestedAt = 0;

  /** Reused scratch buffer so delta application allocates nothing. */
  private readonly changedScratch: number[] = [];

  constructor(
    private readonly socket: SocketClient,
    /**
     * Mutable so components can layer their own handlers on at mount and
     * restore the previous ones at unmount. Callbacks rather than React state
     * is what keeps a 20 Hz delta stream from triggering re-renders.
     */
    readonly callbacks: MatchClientCallbacks = {},
  ) {}

  /** Subscribes to server events. Call once, after the socket connects. */
  attach(): void {
    const raw = this.socket.raw;
    if (!raw) return;

    // Every binary packet is normalised on receipt: Socket.IO delivers typed
    // arrays as Buffer/ArrayBuffer, and reading those as the original view type
    // silently yields wrong values. See `decode.ts`.
    raw.on('world:snapshot', (packet) => this.applySnapshot(decodeSnapshot(packet)));
    raw.on('world:delta', (packet) => this.applyDelta(decodeDelta(packet)));
    raw.on('match:players', (packet) => this.callbacks.onPlayers?.(packet.players));
    raw.on('player:resources', (packet) => this.callbacks.onResources?.(packet.resources));
    raw.on('leaderboard:update', (packet) => this.callbacks.onLeaderboard?.(packet.entries));

    raw.on('cmd:response', (response) => {
      if (!response.ok) this.callbacks.onCommandRejected?.(response.seq, response.reason);
    });

    raw.on('system:notice', (packet) => {
      this.callbacks.onNotice?.(packet.text, packet.severity);
    });
  }

  /**
   * Joins a match and rebuilds the world from the seed the server sends.
   *
   * This is the payoff of the seed-replication design: `match:init` carries a
   * `MapGenParams` object of a few numbers, and the client reconstructs a
   * 5 000-territory world locally rather than downloading it.
   */
  async join(roomId = '', password?: string): Promise<MatchInitPacket | null> {
    const raw = this.socket.raw;
    if (!raw) return null;

    const command = {
      seq: this.socket.nextSeq(),
      roomId,
      ...(password === undefined ? {} : { password }),
      ...(this.reconnectToken === null ? {} : { reconnectToken: this.reconnectToken }),
    };

    return new Promise<MatchInitPacket | null>((resolve) => {
      // A join that never resolves would leave the UI stuck on a spinner with
      // no way forward, so the promise always settles.
      const timeout = setTimeout(() => resolve(null), 15_000);

      raw.emit('match:join', command, (response) => {
        clearTimeout(timeout);

        if (!('mapParams' in response)) {
          resolve(null);
          return;
        }

        this.handleInit(response);
        resolve(response);
      });
    });
  }

  private handleInit(packet: MatchInitPacket): void {
    const geometry = generateWorld(packet.mapParams);

    this.geometry = geometry;
    this.matchId = packet.matchId;
    this.mySlot = packet.yourSlot;
    this.reconnectToken = packet.reconnectToken;

    const count = geometry.territoryCount;
    this.owner = new Uint16Array(count).fill(OWNER_NONE);
    this.population = new Uint32Array(count);
    this.troops = new Uint32Array(count);
    this.building = new Uint8Array(count);
    this.buildingLevel = new Uint8Array(count);

    this.callbacks.onInit?.(geometry, packet);
    // The embedded snapshot crosses the wire as binary too, so it needs the
    // same normalisation as a standalone `world:snapshot`.
    this.applySnapshot(decodeSnapshot(packet.snapshot));
    this.callbacks.onPlayers?.(packet.players);
  }

  /**
   * Replaces all mirrored state.
   *
   * `set` rather than reassignment so the renderer keeps its reference to the
   * same buffer and does not need to be told about a swap.
   */
  private applySnapshot(packet: WorldSnapshotPacket): void {
    if (!this.geometry) return;
    if (packet.owner.length !== this.owner.length) {
      // A length mismatch means the client rebuilt a different world from the
      // server's — a determinism failure. Nothing sensible can be rendered.

      console.error(
        `World size mismatch: server ${packet.owner.length}, client ${this.owner.length}. ` +
          'The deterministic generator has diverged.',
      );
      return;
    }

    this.owner.set(packet.owner);
    this.population.set(packet.population);
    this.troops.set(packet.troops);
    this.building.set(packet.building);
    this.buildingLevel.set(packet.buildingLevel);

    this.lastTick = packet.tick;
    this.callbacks.onFullResync?.();
  }

  /**
   * Applies an incremental update.
   *
   * Each entry carries a bitmask; a value array slot is only meaningful when
   * its bit is set. Reading unmasked slots would apply stale data, because the
   * arrays are dense and the unused slots carry whatever the encoder happened
   * to write.
   */
  private applyDelta(packet: WorldDeltaPacket): void {
    if (!this.geometry) return;

    /**
     * Gap detection. If this delta builds on a tick we never saw, our state is
     * missing changes and every subsequent delta compounds the error. Ask for a
     * keyframe rather than silently drifting.
     */
    if (this.lastTick >= 0 && packet.baseTick > this.lastTick) {
      this.requestResync();
      return;
    }

    const changed = this.changedScratch;
    changed.length = 0;

    for (let i = 0; i < packet.ids.length; i++) {
      const id = packet.ids[i] as number;
      if (id >= this.owner.length) continue;

      const fields = packet.fields[i] as number;

      if (fields & TerritoryField.Owner) this.owner[id] = packet.owner[i] as number;
      if (fields & TerritoryField.Population) this.population[id] = packet.population[i] as number;
      if (fields & TerritoryField.Troops) this.troops[id] = packet.troops[i] as number;
      if (fields & TerritoryField.Building) this.building[id] = packet.building[i] as number;
      if (fields & TerritoryField.BuildingLevel) {
        this.buildingLevel[id] = packet.buildingLevel[i] as number;
      }

      changed.push(id);
    }

    this.lastTick = packet.tick;
    if (changed.length > 0) this.callbacks.onTerritoriesChanged?.(changed);
  }

  /** Requests a keyframe, throttled so a bad stream cannot cause a request storm. */
  private requestResync(): void {
    const now = Date.now();
    if (now - this.resyncRequestedAt < 1000) return;
    this.resyncRequestedAt = now;
    this.socket.raw?.emit('match:resync');
  }

  /* Commands -------------------------------------------------------------- */

  /** Sends an attack intention. The server decides the outcome. */
  attack(from: number, to: number, ratio = 0.5): number {
    const seq = this.socket.nextSeq();
    this.socket.raw?.emit('cmd:attack', { seq, from, to, ratio });
    return seq;
  }

  transfer(from: number, to: number, ratio = 0.5): number {
    const seq = this.socket.nextSeq();
    this.socket.raw?.emit('cmd:transfer', { seq, from, to, ratio });
    return seq;
  }

  leave(surrender = false): void {
    this.socket.raw?.emit('match:leave', { seq: this.socket.nextSeq(), surrender });
    this.matchId = null;
    this.mySlot = -1;
  }

  get isInMatch(): boolean {
    return this.matchId !== null;
  }
}
