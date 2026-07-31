import { randomBytes } from 'node:crypto';
import {
  ECONOMY,
  MAX_PLAYER_SLOTS,
  PlayerStatus,
  RECONNECT_GRACE_MS,
  playerColor,
  type PlayerView,
} from '@borderfall/shared';

/**
 * Per-match player roster: slot allocation, resources, and reconnect handling.
 *
 * Slots are small integers rather than account ids because everything on the
 * hot path — the owner array, combat resolution, the leaderboard — indexes by
 * them. A `Uint16` slot fits in the SoA arrays; a string account id would force
 * a hash lookup per territory per tick.
 */

export interface Player {
  readonly slot: number;
  /** Stable identity across reconnects and matches. */
  readonly accountId: string;
  name: string;
  readonly isBot: boolean;
  status: PlayerStatus;

  /** Current socket, or `null` while disconnected. */
  socketId: string | null;
  /** Wall-clock deadline after which a disconnected player is dropped. */
  graceExpiresAt: number;

  /** Secret that lets a returning client reclaim this slot. */
  readonly reconnectToken: string;

  gold: number;
  food: number;
  allianceId: number | null;

  kills: number;
  deaths: number;
  territoriesCaptured: number;
  territoriesLost: number;

  readonly joinedAt: number;
}

export class PlayerRegistry {
  private readonly bySlot = new Map<number, Player>();
  private readonly byAccount = new Map<string, number>();
  private readonly bySocket = new Map<string, number>();
  private readonly byReconnectToken = new Map<string, number>();

  /** Monotonic slot cursor; slots are never reused within a match. */
  private nextSlot = 0;

  constructor(private readonly maxPlayers: number) {}

  /**
   * Allocates a slot.
   *
   * Slots are not recycled after a player leaves. Reuse would be memory-thrifty
   * and behaviourally wrong: a delta still in flight referencing the old
   * occupant would be applied to the new one, briefly painting territories the
   * wrong colour. At two bytes per slot, never reusing is far cheaper than
   * reasoning about that race.
   */
  add(accountId: string, name: string, isBot: boolean, now: number): Player | null {
    if (this.activeCount >= this.maxPlayers) return null;
    if (this.nextSlot >= MAX_PLAYER_SLOTS) return null;

    const slot = this.nextSlot++;
    const player: Player = {
      slot,
      accountId,
      name,
      isBot,
      status: PlayerStatus.Active,
      socketId: null,
      graceExpiresAt: 0,
      reconnectToken: randomBytes(24).toString('base64url'),
      gold: ECONOMY.startingGold,
      food: ECONOMY.startingFood,
      allianceId: null,
      kills: 0,
      deaths: 0,
      territoriesCaptured: 0,
      territoriesLost: 0,
      joinedAt: now,
    };

    this.bySlot.set(slot, player);
    this.byAccount.set(accountId, slot);
    this.byReconnectToken.set(player.reconnectToken, slot);
    return player;
  }

  bindSocket(slot: number, socketId: string): void {
    const player = this.bySlot.get(slot);
    if (!player) return;
    if (player.socketId) this.bySocket.delete(player.socketId);
    player.socketId = socketId;
    this.bySocket.set(socketId, slot);
  }

  /**
   * Marks a player disconnected and starts the grace timer.
   *
   * Territories are deliberately *not* released here. Dropping an empire the
   * instant a connection blips would make a brief network hiccup unrecoverable
   * and reward opponents for nothing; the grace window lets a genuine reconnect
   * resume seamlessly.
   */
  markDisconnected(socketId: string, now: number): Player | null {
    const slot = this.bySocket.get(socketId);
    if (slot === undefined) return null;

    const player = this.bySlot.get(slot);
    if (!player) return null;

    this.bySocket.delete(socketId);
    player.socketId = null;
    player.status = PlayerStatus.Disconnected;
    player.graceExpiresAt = now + RECONNECT_GRACE_MS;
    return player;
  }

  /** Reclaims a slot with a valid reconnect token. */
  reconnect(token: string, socketId: string): Player | null {
    const slot = this.byReconnectToken.get(token);
    if (slot === undefined) return null;

    const player = this.bySlot.get(slot);
    if (!player) return null;
    // An eliminated or surrendered player has no slot to return to.
    if (player.status === PlayerStatus.Eliminated || player.status === PlayerStatus.Surrendered) {
      return null;
    }

    player.status = PlayerStatus.Active;
    player.graceExpiresAt = 0;
    this.bindSocket(slot, socketId);
    return player;
  }

  /** Players whose grace period has expired and who should now be dropped. */
  expiredDisconnects(now: number): Player[] {
    const expired: Player[] = [];
    for (const player of this.bySlot.values()) {
      if (player.status !== PlayerStatus.Disconnected) continue;
      if (player.graceExpiresAt > 0 && now >= player.graceExpiresAt) expired.push(player);
    }
    return expired;
  }

  remove(slot: number): Player | null {
    const player = this.bySlot.get(slot);
    if (!player) return null;

    this.bySlot.delete(slot);
    this.byAccount.delete(player.accountId);
    this.byReconnectToken.delete(player.reconnectToken);
    if (player.socketId) this.bySocket.delete(player.socketId);
    return player;
  }

  get(slot: number): Player | undefined {
    return this.bySlot.get(slot);
  }

  getBySocket(socketId: string): Player | undefined {
    const slot = this.bySocket.get(socketId);
    return slot === undefined ? undefined : this.bySlot.get(slot);
  }

  getByAccount(accountId: string): Player | undefined {
    const slot = this.byAccount.get(accountId);
    return slot === undefined ? undefined : this.bySlot.get(slot);
  }

  all(): Player[] {
    return [...this.bySlot.values()];
  }

  /** Players who can still act — excludes eliminated and surrendered. */
  activePlayers(): Player[] {
    return this.all().filter(
      (player) =>
        player.status === PlayerStatus.Active || player.status === PlayerStatus.Disconnected,
    );
  }

  get activeCount(): number {
    return this.activePlayers().length;
  }

  get humanCount(): number {
    return this.activePlayers().filter((player) => !player.isBot).length;
  }

  get botCount(): number {
    return this.activePlayers().filter((player) => player.isBot).length;
  }

  /** Public roster view. Resources are excluded — they are private per player. */
  toViews(): PlayerView[] {
    return this.all().map((player) => ({
      slot: player.slot,
      name: player.name,
      isBot: player.isBot,
      status: player.status,
      allianceId: player.allianceId,
      color: playerColor(player.slot),
    }));
  }
}
