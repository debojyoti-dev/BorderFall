import type { Intent, Turn } from '../sim/intents.js';

/**
 * The lockstep wire contract.
 *
 * Replaces the server-authoritative event set. The difference is total: no
 * state ever crosses the wire in either direction. The server sends *turns* —
 * bundles of player inputs — and each client's own simulation derives the world
 * from them.
 *
 * That is what makes a two-million-tile world affordable. Delta-replicating
 * per-tile ownership at 20 Hz to 200 players would be hundreds of megabytes per
 * second; relaying intents is a few bytes per player action.
 */

/** Everything a joining client needs to construct its simulation. */
export interface LockstepStartPacket {
  readonly matchId: string;
  readonly roomCode: string;

  /** The map is regenerated locally from these. It is never transmitted. */
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly turnsPerSecond: number;

  readonly yourSlot: number;
  readonly reconnectToken: string;
  readonly players: readonly LockstepPlayerInfo[];

  /** Turn the match has reached. A late joiner fast-forwards to here. */
  readonly currentTurn: number;

  /**
   * Every turn that actually contained intents.
   *
   * Empty turns are omitted and the client fills the gaps itself. At ten turns
   * a second a ten-minute match is 6 000 turns, the overwhelming majority of
   * them empty; sending only the non-empty ones cuts catch-up payloads by
   * around two orders of magnitude.
   *
   * This history is also, for free, a complete replay of the match.
   */
  readonly history: readonly Turn[];
}

export interface LockstepPlayerInfo {
  readonly slot: number;
  readonly name: string;
  readonly isBot: boolean;
  readonly connected: boolean;
}

/** Sent every turn, whether or not anything happened. */
export interface TurnPacket {
  readonly turn: number;
  readonly intents: readonly Intent[];
}

/** Client's view of its own simulation, for desync detection. */
export interface ChecksumReport {
  readonly turn: number;
  readonly checksum: number;
}

/**
 * Sent when the server sees clients disagree.
 *
 * The server cannot say which client is wrong — it holds no state of its own —
 * so it reports the disagreement and lets clients resynchronise by rebuilding
 * from the history.
 */
export interface DesyncPacket {
  readonly turn: number;
  /** Slots whose checksum differed from the majority. */
  readonly divergentSlots: readonly number[];
  readonly majorityChecksum: number;
}

export interface LockstepClientToServerEvents {
  'lockstep:join': (
    request: { roomId: string; reconnectToken?: string },
    ack: (response: LockstepStartPacket | { error: string }) => void,
  ) => void;

  /**
   * Submits an intent for the current turn.
   *
   * The client sends no `slot` — the server stamps it from the authenticated
   * connection. That single substitution is the only validation a relay can
   * and must perform: without it a client could act as any player, which is
   * the one exploit lockstep cannot detect, because a forged intent is
   * perfectly legal input that every peer would faithfully replay.
   */
  'lockstep:intent': (intent: Omit<Intent, 'slot'>) => void;

  'lockstep:checksum': (report: ChecksumReport) => void;
  'lockstep:leave': () => void;
}

export interface LockstepServerToClientEvents {
  'lockstep:start': (packet: LockstepStartPacket) => void;
  'lockstep:turn': (packet: TurnPacket) => void;
  'lockstep:players': (players: readonly LockstepPlayerInfo[]) => void;
  'lockstep:desync': (packet: DesyncPacket) => void;
  'lockstep:ended': (result: { winnerSlot: number | null; durationTurns: number }) => void;
}
