import { OWNER_NONE, PlayerStatus, type WorldReader } from '@borderfall/shared';
import { BaseSystem, SystemOrder, type SystemContext } from '../engine/System.js';
import type { WorldState } from '../engine/WorldState.js';
import type { PlayerRegistry } from '../match/PlayerRegistry.js';

/**
 * Elimination and win conditions.
 *
 * Runs last and reads only settled state, so it can never observe a territory
 * mid-transfer and eliminate someone who is about to capture something.
 *
 * A player is eliminated when they hold no territory *and* have no army in
 * flight that could still take one. Checking territory alone would eliminate a
 * player during the one-tick window between committing their last garrison to
 * an attack and that attack landing — a bug that would feel outrageous to the
 * player it happened to.
 */
export class VictorySystem extends BaseSystem {
  readonly name = 'victory';
  readonly intervalMs = 2000;
  readonly order = SystemOrder.Victory;

  /** Reused across ticks so the sweep allocates nothing. */
  private readonly territoryCounts: Uint32Array;

  constructor(
    private readonly state: WorldState,
    private readonly reader: WorldReader,
    private readonly players: PlayerRegistry,
    /** Reports armies still in flight for a slot; see CombatSystem. */
    private readonly pendingArmies: (slot: number) => number,
    private readonly onMatchWon: (winnerSlot: number | null) => void,
    maxSlots = 256,
  ) {
    super();
    this.territoryCounts = new Uint32Array(maxSlots);
  }

  update(context: SystemContext): void {
    this.state.countTerritoriesBySlot(this.territoryCounts);

    const survivors: number[] = [];

    for (const player of this.players.activePlayers()) {
      const held = this.territoryCounts[player.slot] ?? 0;

      if (held === 0 && this.pendingArmies(player.slot) === 0) {
        player.status = PlayerStatus.Eliminated;
        context.bus.emit('player:eliminated', {
          slot: player.slot,
          // Attribution requires tracking the last attacker per player, which
          // arrives with the statistics work in Phase 9.
          bySlot: OWNER_NONE,
          finalRank: this.players.activePlayers().length,
        });
        continue;
      }

      if (held > 0) survivors.push(player.slot);
    }

    /**
     * Victory by last-player-standing.
     *
     * Only declared once at least two players have taken part; otherwise a
     * solo player joining an empty room would instantly "win" against nobody.
     */
    if (survivors.length === 1 && this.players.all().length > 1) {
      this.onMatchWon(survivors[0] as number);
      return;
    }

    // Domination: holding most of the habitable world ends the match early
    // rather than forcing a winner to mop up hundreds of trivial tiles.
    const landTotal = Math.max(1, this.reader.countLandTerritories());
    for (const slot of survivors) {
      if ((this.territoryCounts[slot] as number) / landTotal >= 0.75) {
        this.onMatchWon(slot);
        return;
      }
    }
  }
}
