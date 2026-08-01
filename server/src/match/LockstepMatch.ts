import { randomBytes, randomUUID } from 'node:crypto';
import {
  randomSeed,
  type ChecksumReport,
  type Intent,
  type LockstepPlayerInfo,
  type LockstepStartPacket,
  type Turn,
} from '@borderfall/shared';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * A lockstep match: an intent relay and a turn clock.
 *
 * **This class runs no simulation.** It has no map, no territory, no troops. It
 * collects intents, stamps them with the sender's slot, and broadcasts a bundle
 * on a fixed cadence. Every connected client derives the world from those
 * bundles independently.
 *
 * The consequences are worth stating plainly, because they run against the
 * instincts built up in the server-authoritative version:
 *
 * - **The server cannot validate gameplay.** It does not know whose territory
 *   borders whose, or how many troops anyone has. Legality is decided
 *   identically inside every client's simulation.
 * - **The server cannot cheat-check.** A modified client that ignores its own
 *   validation gains nothing, because its peers will not, and it desyncs itself
 *   out of the match.
 * - **The one thing the server must enforce is identity.** A client submits an
 *   intent without a slot; the server stamps it from the authenticated
 *   connection. Skipping that would let any client act as any player, and it is
 *   the single exploit lockstep cannot detect on its own — a forged intent is
 *   perfectly legal input that every peer replays faithfully.
 */

export interface LockstepConfig {
  readonly name: string;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly turnsPerSecond: number;
  readonly maxPlayers: number;
}

export interface LockstepPlayer {
  readonly slot: number;
  readonly accountId: string;
  name: string;
  isBot: boolean;
  socketId: string | null;
  connected: boolean;
  readonly reconnectToken: string;
  /** Most recent checksum reported by this client, for desync detection. */
  lastChecksum: ChecksumReport | null;
}

export interface LockstepCallbacks {
  /** Broadcasts a turn to every connected client. */
  onTurn(turn: Turn): void;
  onDesync(turn: number, divergentSlots: number[], majorityChecksum: number): void;
}

export class LockstepMatch {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  readonly log: Logger;

  private readonly players = new Map<number, LockstepPlayer>();
  private readonly bySocket = new Map<string, number>();
  private readonly byToken = new Map<string, number>();
  private nextSlot = 0;

  /** Intents accumulated since the last turn boundary. */
  private pending: Intent[] = [];

  /**
   * Turns that contained intents, in order.
   *
   * Empty turns are not stored: at ten turns a second most are empty, and a
   * late joiner can reconstruct them from the turn numbers around the gaps.
   * This doubles as the match replay at zero extra cost.
   */
  private readonly history: Turn[] = [];

  private turnNumber = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    readonly config: LockstepConfig,
    readonly code: string,
    private readonly callbacks: LockstepCallbacks,
  ) {
    this.log = createLogger(`lockstep:${code}`);
  }

  static defaultConfig(overrides: Partial<LockstepConfig> = {}): LockstepConfig {
    return {
      name: overrides.name ?? 'Public Match',
      seed: overrides.seed ?? randomSeed(),
      width: overrides.width ?? 1024,
      height: overrides.height ?? 512,
      // Ten turns a second. Fast enough that input feels responsive, slow
      // enough that one dropped packet costs 100 ms rather than a visible
      // stall — and it bounds how far ahead any client can run.
      turnsPerSecond: overrides.turnsPerSecond ?? 10,
      maxPlayers: overrides.maxPlayers ?? 64,
    };
  }

  /* Lifecycle -------------------------------------------------------------- */

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = 1000 / this.config.turnsPerSecond;
    this.timer = setInterval(() => this.emitTurn(), intervalMs);

    this.log.info('Relay started', {
      turnsPerSecond: this.config.turnsPerSecond,
      seed: this.config.seed,
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * Closes the current turn and broadcasts it.
   *
   * A turn is emitted **whether or not it contains intents**. Clients block
   * waiting for turn *n* before simulating it, so a skipped turn would stall
   * every client in the match; the empty turn is the heartbeat that advances
   * the simulation.
   */
  private emitTurn(): void {
    this.turnNumber++;

    const intents = this.pending;
    // Swap rather than clear: an intent arriving during the broadcast belongs
    // to the *next* turn, and clearing in place would silently drop it.
    this.pending = [];

    const turn: Turn = { turn: this.turnNumber, intents };
    if (intents.length > 0) this.history.push(turn);

    this.callbacks.onTurn(turn);
  }

  /* Players ---------------------------------------------------------------- */

  addPlayer(accountId: string, name: string, isBot: boolean): LockstepPlayer | null {
    if (this.players.size >= this.config.maxPlayers) return null;

    const slot = this.nextSlot++;
    const player: LockstepPlayer = {
      slot,
      accountId,
      name,
      isBot,
      socketId: null,
      connected: false,
      reconnectToken: randomBytes(24).toString('base64url'),
      lastChecksum: null,
    };

    this.players.set(slot, player);
    this.byToken.set(player.reconnectToken, slot);
    return player;
  }

  bindSocket(slot: number, socketId: string): void {
    const player = this.players.get(slot);
    if (!player) return;

    if (player.socketId) this.bySocket.delete(player.socketId);
    player.socketId = socketId;
    player.connected = true;
    this.bySocket.set(socketId, slot);
  }

  /**
   * Marks a player disconnected without removing them.
   *
   * Their slot, and everything their simulation owns on every other client,
   * stays exactly where it is. There is nothing for the server to release,
   * because the server holds no territory — a disconnected empire simply stops
   * issuing intents and sits there until it is conquered or the player returns.
   */
  markDisconnected(socketId: string): LockstepPlayer | null {
    const slot = this.bySocket.get(socketId);
    if (slot === undefined) return null;

    const player = this.players.get(slot);
    if (!player) return null;

    this.bySocket.delete(socketId);
    player.socketId = null;
    player.connected = false;
    return player;
  }

  reconnect(token: string, socketId: string): LockstepPlayer | null {
    const slot = this.byToken.get(token);
    if (slot === undefined) return null;

    const player = this.players.get(slot);
    if (!player) return null;

    this.bindSocket(slot, socketId);
    return player;
  }

  playerBySocket(socketId: string): LockstepPlayer | undefined {
    const slot = this.bySocket.get(socketId);
    return slot === undefined ? undefined : this.players.get(slot);
  }

  playerInfo(): LockstepPlayerInfo[] {
    return [...this.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((player) => ({
        slot: player.slot,
        name: player.name,
        isBot: player.isBot,
        connected: player.connected,
      }));
  }

  get playerCount(): number {
    return this.players.size;
  }

  get connectedCount(): number {
    return [...this.players.values()].filter((player) => player.connected).length;
  }

  get hasCapacity(): boolean {
    return this.players.size < this.config.maxPlayers;
  }

  /* Intents ---------------------------------------------------------------- */

  /**
   * Queues an intent for the next turn boundary.
   *
   * `slot` is supplied by the caller from the authenticated connection, never
   * from the payload. See the note on identity in the class documentation.
   */
  submitIntent(slot: number, intent: Omit<Intent, 'slot'>): boolean {
    const player = this.players.get(slot);
    if (!player) return false;
    if (!this.running) return false;

    // Shape check only. The relay cannot judge whether the action is *legal* —
    // it has no world to check against — but it can refuse malformed payloads
    // before they reach every client's simulation.
    if (typeof intent !== 'object' || intent === null) return false;
    if (typeof (intent as { type?: unknown }).type !== 'number') return false;

    this.pending.push({ ...intent, slot } as Intent);
    return true;
  }

  /* Desync detection -------------------------------------------------------- */

  /**
   * Records a client's checksum and compares it against its peers.
   *
   * The server holds no state, so it cannot say which client is *right*. It can
   * only observe disagreement and report it. Majority wins, which is the best a
   * relay can do and is sufficient in practice: a divergent client is almost
   * always a lone client with a bug or a modification.
   */
  reportChecksum(slot: number, report: ChecksumReport): void {
    const player = this.players.get(slot);
    if (!player) return;
    player.lastChecksum = report;

    const atTurn = [...this.players.values()].filter(
      (candidate) => candidate.connected && candidate.lastChecksum?.turn === report.turn,
    );
    // A single report proves nothing; disagreement needs at least two opinions.
    if (atTurn.length < 2) return;

    const tally = new Map<number, number>();
    for (const candidate of atTurn) {
      const value = candidate.lastChecksum!.checksum;
      tally.set(value, (tally.get(value) ?? 0) + 1);
    }
    if (tally.size === 1) return;

    let majority = 0;
    let majorityCount = -1;
    for (const [value, count] of tally) {
      if (count > majorityCount) {
        majority = value;
        majorityCount = count;
      }
    }

    const divergent = atTurn
      .filter((candidate) => candidate.lastChecksum!.checksum !== majority)
      .map((candidate) => candidate.slot);

    this.log.warn('Desync detected', {
      turn: report.turn,
      divergent: divergent.join(','),
      opinions: tally.size,
    });
    this.callbacks.onDesync(report.turn, divergent, majority);
  }

  /* Join payload ------------------------------------------------------------ */

  startPacketFor(player: LockstepPlayer): LockstepStartPacket {
    return {
      matchId: this.id,
      roomCode: this.code,
      seed: this.config.seed,
      width: this.config.width,
      height: this.config.height,
      turnsPerSecond: this.config.turnsPerSecond,
      yourSlot: player.slot,
      reconnectToken: player.reconnectToken,
      players: this.playerInfo(),
      currentTurn: this.turnNumber,
      // Only the turns that mattered. The client replays these and fills the
      // gaps with empty turns to reach `currentTurn`.
      history: [...this.history],
    };
  }

  get turn(): number {
    return this.turnNumber;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The full match input log — a replay, obtained for free. */
  replayHistory(): readonly Turn[] {
    return this.history;
  }
}
