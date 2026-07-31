import { COMBAT, IdAllocator, OWNER_NONE, type WorldReader } from '@borderfall/shared';
import { BaseSystem, SystemOrder, type SystemContext } from '../engine/System.js';
import type { WorldState } from '../engine/WorldState.js';
import type { PlayerRegistry } from '../match/PlayerRegistry.js';
import { defenceMultiplier, traversalCost } from './modifiers.js';

/**
 * An army between leaving its source and resolving at its target.
 *
 * Armies are held here rather than in `WorldState` because they are not a
 * property of any territory — they are in motion between two. Keeping them
 * inside the system that owns them is what the system contract asks for, and it
 * means no other system can mutate a battle mid-resolution.
 */
interface Army {
  readonly id: number;
  readonly owner: number;
  readonly from: number;
  readonly to: number;
  troops: number;
  /** Simulation time at which the army reaches its target. */
  readonly arrivesAt: number;
  engaged: boolean;
}

/**
 * Attack resolution: transit, attrition, capture.
 *
 * ## Why armies spend time in transit
 *
 * Phase 3 resolved attacks instantly, which made position meaningless — a
 * player could strike anywhere on their border with no warning and no window
 * to respond. Transit time turns the map into a real space: reinforcing a
 * threatened tile becomes possible, mountains become genuinely hard to cross,
 * and the defender gets the counterplay that makes an attack a decision rather
 * than a click.
 *
 * ## Why attrition is Lanchester's square law
 *
 * Each side loses troops in proportion to the *opposing* force, so combat
 * power scales with the square of numbers. That single choice produces the
 * central strategic lever of the genre: concentrating force is superior to
 * spreading it. Under a linear law two 50-troop attacks equal one of 100, and
 * there is no reason to ever mass an army.
 *
 * Resolution runs over several 100 ms ticks rather than in one step, so a
 * battle is visible while it happens and reinforcements can still arrive.
 */
export class CombatSystem extends BaseSystem {
  readonly name = 'combat';
  readonly intervalMs = 100;
  readonly order = SystemOrder.Combat;

  private readonly armies: Army[] = [];
  private readonly ids = new IdAllocator();

  constructor(
    private readonly state: WorldState,
    private readonly reader: WorldReader,
    private readonly players: PlayerRegistry,
  ) {
    super();
  }

  override init(context: SystemContext): void {
    /**
     * Attacks arrive as events, not method calls.
     *
     * The network router validates a command and emits; this system consumes.
     * Neither imports the other, so command handling can be tested without a
     * simulation and the simulation without a socket.
     */
    this.subscribe(
      context.bus.on('combat:attack-launched', (event) => {
        this.launch(event.attackerSlot, event.from, event.to, event.troops, event.arrivesAt);
      }),
    );
  }

  /** Computes arrival time for an attack. Used by the router to fill the event. */
  travelTimeMs(from: number, to: number): number {
    // Cost is a property of the destination — crossing into mountains is slow
    // regardless of where you set out from.
    const cost = traversalCost(this.reader, to) + traversalCost(this.reader, from) * 0.25;
    return cost * COMBAT.traversalMsPerCostUnit;
  }

  private launch(owner: number, from: number, to: number, troops: number, arrivesAt: number): void {
    if (troops <= 0) return;
    this.armies.push({
      id: this.ids.allocate(),
      owner,
      from,
      to,
      troops,
      arrivesAt,
      engaged: false,
    });
    this.state.setContested(to, true);
  }

  update(context: SystemContext, deltaMs: number): void {
    const seconds = deltaMs / 1000;

    for (let index = this.armies.length - 1; index >= 0; index--) {
      const army = this.armies[index] as Army;

      if (!army.engaged) {
        if (context.elapsedMs < army.arrivesAt) continue;
        army.engaged = true;

        // On arrival the target may no longer be hostile — it could have been
        // taken by an ally, or by this player's own earlier wave. Treat that
        // as a reinforcement rather than an attack on themselves.
        if (this.isFriendly(army.owner, army.to)) {
          this.state.setTroops(army.to, (this.state.troops[army.to] as number) + army.troops);
          this.retire(index, army.to);
          continue;
        }
      }

      const resolved = this.resolveRound(context, army, seconds);
      if (resolved) this.retire(index, army.to);
    }
  }

  /** True when the territory belongs to the attacker or one of their allies. */
  private isFriendly(slot: number, territory: number): boolean {
    const owner = this.state.getOwner(territory);
    if (owner === slot) return true;
    if (owner === OWNER_NONE) return false;

    const attacker = this.players.get(slot);
    const defender = this.players.get(owner);
    return (
      attacker !== undefined &&
      defender !== undefined &&
      attacker.allianceId !== null &&
      attacker.allianceId === defender.allianceId
    );
  }

  /**
   * One round of attrition. Returns true when the battle has concluded.
   */
  private resolveRound(context: SystemContext, army: Army, seconds: number): boolean {
    const world = this.state;
    const target = army.to;

    const defenderSlot = world.getOwner(target);
    const defendingTroops = world.troops[target] as number;

    // Undefended: walk in. Common for neutral expansion, and resolving it in
    // one step avoids a pointless multi-tick battle against nothing.
    if (defendingTroops <= 0) {
      this.capture(context, army, defenderSlot, 0);
      return true;
    }

    const defence =
      defendingTroops * defenceMultiplier(world, this.reader, target) * COMBAT.baseDefenceBonus;
    const attack = army.troops;

    // Symmetric variance around 1, so the roll favours neither side on average.
    const roll = context.rng.nextFloat();
    const variance = 1 + (roll * 2 - 1) * COMBAT.randomVariance;

    // A critical event doubles one side's output for this round — enough to
    // matter in a close fight, not enough to decide a lopsided one.
    let attackerBonus = 1;
    let defenderBonus = 1;
    let critical = false;
    if (context.rng.chance(COMBAT.criticalChance)) {
      critical = true;
      if (context.rng.chance(0.5)) attackerBonus = COMBAT.criticalMultiplier;
      else defenderBonus = COMBAT.criticalMultiplier;
    }

    // Lanchester: each side's losses are proportional to the opposing force.
    const attackerLosses = defence * COMBAT.attackerAttritionCoefficient * defenderBonus * seconds;
    const defenderLosses =
      attack * COMBAT.defenderAttritionCoefficient * variance * attackerBonus * seconds;

    army.troops -= attackerLosses;
    const remainingDefenders = defendingTroops - defenderLosses;

    if (remainingDefenders <= 0 && army.troops > 0) {
      this.capture(context, army, defenderSlot, defendingTroops);
      return true;
    }

    world.setTroops(target, Math.max(0, remainingDefenders));

    if (army.troops <= 0) {
      // Assault repelled.
      const defender = this.players.get(defenderSlot);
      if (defender) defender.kills++;

      context.bus.emit('combat:resolved', {
        from: army.from,
        to: target,
        attackerSlot: army.owner,
        defenderSlot,
        attackerLosses: Math.round(attackerLosses),
        defenderLosses: Math.round(defenderLosses),
        captured: false,
        critical,
        tick: context.tick,
      });
      return true;
    }

    return false;
  }

  private capture(
    context: SystemContext,
    army: Army,
    previousOwner: number,
    defenderLosses: number,
  ): void {
    const world = this.state;
    const target = army.to;

    const survivors = Math.max(1, Math.floor(army.troops * COMBAT.occupationRatio));

    if (previousOwner !== OWNER_NONE) {
      const defender = this.players.get(previousOwner);
      if (defender) {
        defender.territoriesLost++;
        defender.deaths++;
      }
      const attacker = this.players.get(army.owner);
      if (attacker) attacker.kills++;
    }

    const attacker = this.players.get(army.owner);
    if (attacker) attacker.territoriesCaptured++;

    world.setOwner(target, army.owner);
    world.setTroops(target, survivors);
    // Conquest is costly for the inhabitants; the survivors inherit a fraction.
    world.setPopulation(
      target,
      Math.floor((world.population[target] as number) * COMBAT.occupationRatio * 0.4),
    );

    context.bus.emit('territory:captured', {
      territory: target,
      previousOwner,
      newOwner: army.owner,
      troopsLost: Math.round(army.troops - survivors),
      tick: context.tick,
    });

    context.bus.emit('combat:resolved', {
      from: army.from,
      to: target,
      attackerSlot: army.owner,
      defenderSlot: previousOwner,
      attackerLosses: Math.round(army.troops - survivors),
      defenderLosses: Math.round(defenderLosses),
      captured: true,
      critical: false,
      tick: context.tick,
    });
  }

  /**
   * Removes an army and clears the contested flag if it was the last one
   * fighting over that territory.
   */
  private retire(index: number, territory: number): void {
    this.armies.splice(index, 1);

    const stillContested = this.armies.some((army) => army.to === territory);
    if (!stillContested) this.state.setContested(territory, false);
  }

  /** Number of armies in flight or fighting. Used by tests and metrics. */
  get activeArmies(): number {
    return this.armies.length;
  }

  /** Armies currently targeting a territory, for the inspector panel. */
  armiesTargeting(territory: number): number {
    let count = 0;
    for (const army of this.armies) if (army.to === territory) count++;
    return count;
  }

  /**
   * Armies belonging to a slot, in flight or engaged.
   *
   * The victory system uses this so a player is not eliminated in the window
   * between committing their last garrison and that attack landing.
   */
  armiesOwnedBy(slot: number): number {
    let count = 0;
    for (const army of this.armies) if (army.owner === slot) count++;
    return count;
  }

  /** Discards every army held by a slot, e.g. on elimination. */
  releaseSlot(slot: number): void {
    for (let index = this.armies.length - 1; index >= 0; index--) {
      const army = this.armies[index] as Army;
      if (army.owner !== slot) continue;
      // Read the target before retiring: `retire` splices, so indexing again
      // afterwards would reference a different army.
      this.retire(index, army.to);
    }
  }
}
