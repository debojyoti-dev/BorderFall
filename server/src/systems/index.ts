import type { MatchInstance } from '../match/MatchInstance.js';
import { CombatSystem } from './CombatSystem.js';
import { EconomySystem } from './EconomySystem.js';
import { PopulationSystem } from './PopulationSystem.js';
import { VictorySystem } from './VictorySystem.js';

export { CombatSystem } from './CombatSystem.js';
export { EconomySystem } from './EconomySystem.js';
export { PopulationSystem } from './PopulationSystem.js';
export { VictorySystem } from './VictorySystem.js';
export * from './modifiers.js';

/**
 * Registers the core simulation for a match.
 *
 * Execution order comes from each system's `order` field, not from the order
 * of these calls — see `SystemOrder`. Registration order is easy to change by
 * accident and impossible to reason about later, so it is deliberately not
 * load-bearing.
 *
 * The combat system is returned because the router needs it to compute travel
 * times when validating an attack, and the victory system needs it to ask
 * whether a territoryless player still has an army in flight.
 */
export function registerCoreSystems(match: MatchInstance): CombatSystem {
  const combat = new CombatSystem(match.world, match.reader, match.players);

  match.registerSystem(new PopulationSystem(match.world, match.reader));
  match.registerSystem(new EconomySystem(match.world, match.reader, match.players));
  match.registerSystem(combat);
  match.registerSystem(
    new VictorySystem(
      match.world,
      match.reader,
      match.players,
      (slot) => combat.armiesOwnedBy(slot),
      (winner) => match.end(winner),
    ),
  );

  return combat;
}
