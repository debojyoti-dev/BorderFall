import { Rng } from '../utils/prng.js';
import { Attack, defenderLosses } from '../world/Conquest.js';
import { TILE_OWNER_NONE, type TileMap, type TileRef } from '../world/TileMap.js';
import { TileWorld, type TilePlayerState } from '../world/TileWorld.js';
import { createTileParams, generateTileMap } from '../world/tilegen.js';
import { IntentType, type Intent, type Turn } from './intents.js';

/**
 * The deterministic simulation core.
 *
 * ## Why this lives in `shared/`
 *
 * Under lockstep the server does not simulate — it relays turns. Every client
 * runs *this* class, and every client must reach byte-identical state. The
 * simulation therefore cannot live in `server/`; it has to be code both
 * runtimes execute from the same source.
 *
 * ## The determinism contract
 *
 * Everything here obeys four rules, and a violation of any one desyncs the
 * match rather than producing a visible error:
 *
 * 1. **No wall clock.** Time is the turn counter. `Date.now()` is banned.
 * 2. **No ambient randomness.** All draws come from the seeded {@link Rng}.
 * 3. **Fixed iteration order.** Players are iterated by slot, attacks in
 *    creation order. Iterating a `Map` by insertion order is fine; iterating an
 *    object's keys is not.
 * 4. **No floating-point dependence on input order.** Accumulations that could
 *    reorder are summed in a fixed sequence.
 *
 * ## Why validation happens here too
 *
 * The server no longer validates commands, because it no longer holds
 * authoritative state. Validation instead happens identically on every client
 * as part of applying a turn — an illegal intent is rejected the same way
 * everywhere, so rejection itself stays deterministic. A cheating client cannot
 * gain anything by skipping the check locally: its peers will not, and it would
 * simply desync itself out of the match.
 */

export const TILE_BALANCE = {
  /** Troops a player starts with on spawning. */
  startingTroops: 5000,
  startingGold: 0,

  /**
   * Empire army ceiling: `base · tiles^exponent + structures`.
   *
   * The sublinear exponent is the anti-snowball lever. Four times the land
   * yields roughly two and a half times the army, so conquest has diminishing
   * military returns and a smaller player is never mathematically hopeless.
   */
  troopBase: 1400,
  troopExponent: 0.6,
  troopFloor: 12_000,

  /** Fraction of the gap to the ceiling recovered per second. */
  troopGrowthRate: 0.03,
  /** Flat troop gain per second, so a wiped-out player can rebuild. */
  troopGrowthFloor: 30,

  /** Gold per owned tile per second. */
  goldPerTilePerSecond: 0.012,
  /** Flat gold per second, so a tiny player still accumulates something. */
  goldFlatPerSecond: 1,
  maxGold: 100_000_000,

  /** Fraction of the pool an attack may commit, clamped. */
  minAttackRatio: 0.01,
  maxAttackRatio: 1,
} as const;

export interface TileGameConfig {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly landRatio?: number;
  /** Turns per simulated second. Fixed for the lifetime of a match. */
  readonly turnsPerSecond?: number;
}

export interface TileGamePlayer extends TilePlayerState {
  name: string;
  isBot: boolean;
  alive: boolean;
  hasSpawned: boolean;
  /** Alliance partners, by slot. Symmetric. */
  readonly allies: Set<number>;
}

export class TileGame {
  readonly map: TileMap;
  readonly world: TileWorld;
  readonly turnsPerSecond: number;

  /** Turns applied so far. This is the simulation's only notion of time. */
  private turnNumber = 0;

  private readonly rng: Rng;
  private readonly conquestRng: Rng;

  /**
   * Active attacks, in creation order.
   *
   * An array rather than a map because iteration order is part of the
   * determinism contract, and creation order is stable across clients since
   * intents arrive in a fixed order within a turn.
   */
  private readonly attacks: Attack[] = [];

  private readonly playerMeta = new Map<number, TileGamePlayer>();

  constructor(readonly config: TileGameConfig) {
    const params = createTileParams(config.seed, {
      width: config.width,
      height: config.height,
      ...(config.landRatio === undefined ? {} : { landRatio: config.landRatio }),
    });

    this.map = generateTileMap(params);
    this.world = new TileWorld(this.map);
    this.turnsPerSecond = config.turnsPerSecond ?? 10;

    // Streams are forked by name so adding a draw in one subsystem cannot
    // shift the sequence another observes — which would otherwise change
    // terrain when a combat tweak shipped, and break every stored replay.
    const root = new Rng(config.seed);
    this.rng = root.fork('sim');
    this.conquestRng = root.fork('conquest');
  }

  /* Players ---------------------------------------------------------------- */

  addPlayer(slot: number, name: string, isBot: boolean): TileGamePlayer {
    const base = this.world.addPlayer(slot, 0, TILE_BALANCE.startingGold);

    /**
     * Extend the world's state object in place — never spread it.
     *
     * `{ ...base }` would produce a *second* object: `TileWorld` would keep
     * incrementing `tilesOwned` on the original while the game read the copy,
     * so territory counts, troops and gold would silently stay at zero. The
     * two must be the same object.
     */
    const player = Object.assign(base, {
      name,
      isBot,
      alive: true,
      hasSpawned: false,
      allies: new Set<number>(),
    }) as TileGamePlayer;

    this.playerMeta.set(slot, player);
    return player;
  }

  player(slot: number): TileGamePlayer | undefined {
    return this.playerMeta.get(slot);
  }

  /** Players in slot order — the fixed iteration required for determinism. */
  players(): TileGamePlayer[] {
    return [...this.playerMeta.values()].sort((a, b) => a.slot - b.slot);
  }

  areAllied(a: number, b: number): boolean {
    return this.playerMeta.get(a)?.allies.has(b) ?? false;
  }

  /* Turn application -------------------------------------------------------- */

  /**
   * Applies one turn and advances the simulation by one step.
   *
   * Intents are applied before the step, so a command issued this turn takes
   * effect this turn on every client. The order is: apply intents in the order
   * received, then advance continuous systems.
   */
  applyTurn(turn: Turn): void {
    for (const intent of turn.intents) {
      this.applyIntent(intent);
    }
    this.turnNumber = turn.turn;
    this.step();
  }

  private applyIntent(intent: Intent): void {
    const player = this.playerMeta.get(intent.slot);
    if (!player || !player.alive) return;

    switch (intent.type) {
      case IntentType.Spawn:
        this.handleSpawn(player, intent.tile);
        break;
      case IntentType.Attack:
        this.handleAttack(player, intent.target, intent.ratio);
        break;
      case IntentType.Retreat:
        this.handleRetreat(player, intent.target);
        break;
      case IntentType.AllianceRequest:
      case IntentType.AllianceResponse:
      case IntentType.BreakAlliance:
      case IntentType.Build:
      case IntentType.Boat:
      case IntentType.Nuke:
      case IntentType.Donate:
      case IntentType.Embargo:
      case IntentType.QuickChat:
      case IntentType.Emoji:
      case IntentType.TargetPlayer:
        // Handled in later phases. Unknown-but-declared intents are ignored
        // rather than throwing, so a newer client's intent cannot crash an
        // older peer mid-match.
        break;
      default:
        break;
    }
  }

  /* Intent handlers --------------------------------------------------------- */

  private handleSpawn(player: TileGamePlayer, tile: TileRef): void {
    if (player.hasSpawned) return;
    if (!this.map.isValidRef(tile)) return;
    if (!this.map.isLand(tile)) return;
    if (this.map.ownerOf(tile) !== TILE_OWNER_NONE) return;

    this.world.setOwner(tile, player.slot);
    player.hasSpawned = true;
    player.troops = TILE_BALANCE.startingTroops;

    // A single tile is not a viable start; claim a small radius so the player
    // has a frontier to expand from.
    this.map.forEachNeighbourWithDiagonals(tile, (neighbour) => {
      if (this.map.isLand(neighbour) && this.map.ownerOf(neighbour) === TILE_OWNER_NONE) {
        this.world.setOwner(neighbour, player.slot);
      }
    });
  }

  private handleAttack(player: TileGamePlayer, target: number, ratio: number): void {
    if (!player.hasSpawned) return;
    if (target === player.slot) return;
    if (!Number.isFinite(ratio)) return;

    // Alliances block attacks. Checked here rather than at the network edge,
    // because under lockstep the network edge has no authoritative state.
    if (target !== TILE_OWNER_NONE && player.allies.has(target)) return;

    const clamped = Math.min(
      TILE_BALANCE.maxAttackRatio,
      Math.max(TILE_BALANCE.minAttackRatio, ratio),
    );
    const committed = Math.floor(player.troops * clamped);
    if (committed <= 0) return;

    // Only one attack per attacker/target pair; a second intent reinforces the
    // existing front rather than opening a duplicate.
    const existing = this.attacks.find(
      (attack) => attack.attacker === player.slot && attack.target === target && !attack.isFinished,
    );
    if (existing) {
      existing.troops += committed;
      player.troops -= committed;
      return;
    }

    const attack = new Attack({ attacker: player.slot, target, troops: committed });
    attack.begin(this.world, this.conquestRng, this.turnNumber);
    if (attack.isFinished) return; // No shared border.

    player.troops -= committed;
    this.attacks.push(attack);
  }

  private handleRetreat(player: TileGamePlayer, target: number): void {
    for (const attack of this.attacks) {
      if (attack.attacker !== player.slot || attack.target !== target) continue;
      // Surviving troops come home. Retreating must be a real option, or every
      // attack is a commitment to total loss.
      player.troops += attack.troops;
      attack.cancel();
    }
  }

  /* Simulation step --------------------------------------------------------- */

  private step(): void {
    const seconds = 1 / this.turnsPerSecond;

    this.stepAttacks(seconds);
    this.stepEconomy(seconds);
    this.stepElimination();
  }

  private stepAttacks(seconds: number): void {
    for (let index = this.attacks.length - 1; index >= 0; index--) {
      const attack = this.attacks[index] as Attack;

      if (attack.isFinished) {
        // Surviving troops rejoin the pool when a front runs out of ground.
        const attacker = this.playerMeta.get(attack.attacker);
        if (attacker) attacker.troops += Math.max(0, attack.troops);
        this.attacks.splice(index, 1);
        continue;
      }

      const defender =
        attack.target === TILE_OWNER_NONE ? undefined : this.playerMeta.get(attack.target);
      const defenderTroops = defender?.troops ?? 0;

      const taken = attack.step(
        this.world,
        this.conquestRng,
        this.turnNumber,
        seconds,
        defenderTroops,
      );

      // The defender pays for ground lost, which is what makes a losing war
      // compound rather than stalling at a fixed cost.
      if (defender && taken > 0) {
        defender.troops = Math.max(0, defender.troops - defenderLosses(taken));
      }
    }
  }

  private stepEconomy(seconds: number): void {
    for (const player of this.players()) {
      if (!player.alive || !player.hasSpawned) continue;

      const ceiling = this.troopCeiling(player);
      if (player.troops < ceiling) {
        // Approach the ceiling asymptotically, plus a flat floor so a player
        // reduced to nothing can still rebuild.
        const gap = ceiling - player.troops;
        player.troops = Math.min(
          ceiling,
          player.troops +
            (gap * TILE_BALANCE.troopGrowthRate + TILE_BALANCE.troopGrowthFloor) * seconds,
        );
      }

      player.gold = Math.min(
        TILE_BALANCE.maxGold,
        player.gold +
          (player.tilesOwned * TILE_BALANCE.goldPerTilePerSecond + TILE_BALANCE.goldFlatPerSecond) *
            seconds,
      );
    }
  }

  /** Sublinear army ceiling. See {@link TILE_BALANCE}. */
  troopCeiling(player: TileGamePlayer): number {
    return (
      TILE_BALANCE.troopFloor +
      TILE_BALANCE.troopBase * Math.pow(Math.max(0, player.tilesOwned), TILE_BALANCE.troopExponent)
    );
  }

  private stepElimination(): void {
    for (const player of this.players()) {
      if (!player.alive || !player.hasSpawned) continue;
      if (player.tilesOwned > 0) continue;

      // Holding no ground *and* having nothing in the field. Checking tiles
      // alone would eliminate a player in the window between committing their
      // last troops to an attack and that attack taking its first tile.
      const hasAttack = this.attacks.some(
        (attack) => attack.attacker === player.slot && !attack.isFinished,
      );
      if (hasAttack) continue;

      player.alive = false;
      for (const attack of this.attacks) {
        if (attack.attacker === player.slot) attack.cancel();
      }
    }
  }

  /* Queries ----------------------------------------------------------------- */

  get turn(): number {
    return this.turnNumber;
  }

  /** Simulated seconds elapsed. Derived from turns, never from a clock. */
  get elapsedSeconds(): number {
    return this.turnNumber / this.turnsPerSecond;
  }

  get activeAttacks(): number {
    return this.attacks.length;
  }

  attacksBy(slot: number): number {
    return this.attacks.filter((attack) => attack.attacker === slot && !attack.isFinished).length;
  }

  livingPlayers(): TileGamePlayer[] {
    return this.players().filter((player) => player.alive && player.hasSpawned);
  }

  /**
   * Fingerprint of the whole simulation.
   *
   * Two clients on the same turn must produce the same value. Comparing this
   * periodically is how a lockstep match detects desync — which is otherwise
   * invisible until the two players see different maps and neither can say why.
   */
  checksum(): number {
    let hash = 0x811c9dc5;

    // Ownership dominates the state, and sampling is enough to catch drift
    // without walking two million tiles every check.
    //
    // Terrain is folded in as well. It never changes after generation, but
    // that is exactly why it belongs here: if two clients generated *different
    // maps* from the same seed, every later check would compare ownership on
    // incompatible worlds and could easily agree by coincidence while the
    // players see entirely different continents.
    const stride = Math.max(1, Math.floor(this.map.tileCount / 8192));
    for (let ref = 0; ref < this.map.tileCount; ref += stride) {
      hash ^= this.map.owner[ref] as number;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= this.map.terrain[ref] as number;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    for (const player of this.players()) {
      hash ^= player.tilesOwned;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= Math.floor(player.troops);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    hash ^= this.turnNumber;
    return Math.imul(hash, 0x01000193) >>> 0;
  }

  /** Unused root stream, exposed for systems added in later phases. */
  get simulationRng(): Rng {
    return this.rng;
  }
}
