import {
  COMBAT,
  MatchState,
  OWNER_NONE,
  PlayerStatus,
  RejectReason,
  fail,
  isFiniteNumberInRange,
  isIntegerInRange,
  ok,
  type AttackCommand,
  type Result,
  type TransferTroopsCommand,
} from '@borderfall/shared';
import type { MatchInstance } from './MatchInstance.js';
import type { Player } from './PlayerRegistry.js';

/**
 * Command validation and application.
 *
 * Every function here assumes the payload is hostile. The client is not a
 * source of truth about anything — not ownership, not troop counts, not
 * adjacency — so each value is re-derived from server state before use. Even
 * the shape is re-checked, because a modified client can emit whatever it likes
 * and TypeScript types evaporate at runtime.
 *
 * Validation is ordered cheapest-first: type checks, then bounds, then state
 * lookups, then the expensive graph query. A flood of malformed packets is
 * rejected without ever touching the world.
 */

/** Per-territory attack cooldown, keyed `territoryId`, valued as a timestamp. */
export type CooldownMap = Map<number, number>;

/* -------------------------------------------------------------------------- */
/* Attack                                                                      */
/* -------------------------------------------------------------------------- */

export function validateAttack(
  match: MatchInstance,
  player: Player,
  command: AttackCommand,
  cooldowns: CooldownMap,
  now: number,
): Result<{ from: number; to: number; troops: number }> {
  if (match.matchState !== MatchState.Running) return fail(RejectReason.MatchNotRunning);
  if (player.status !== PlayerStatus.Active) return fail(RejectReason.NotAPlayer);

  // Shape first — a non-integer id would index a typed array as `undefined`.
  if (!isIntegerInRange(command.from, 0, match.world.territoryCount - 1)) {
    return fail(RejectReason.UnknownTerritory, 'from out of range');
  }
  if (!isIntegerInRange(command.to, 0, match.world.territoryCount - 1)) {
    return fail(RejectReason.UnknownTerritory, 'to out of range');
  }
  if (!isFiniteNumberInRange(command.ratio, 0.01, 1)) {
    return fail(RejectReason.MalformedPacket, 'ratio out of range');
  }
  if (command.from === command.to) return fail(RejectReason.SelfTargeted);

  const { from, to } = command;

  if (!match.world.isOwnedBy(from, player.slot)) return fail(RejectReason.NotOwner);
  if (match.world.isOwnedBy(to, player.slot)) return fail(RejectReason.AlreadyOwned);

  // Land armies cannot cross water; that is what ships are for (Phase 6).
  if (!match.reader.isLand(to)) return fail(RejectReason.InvalidTerrain);

  // Adjacency is re-derived from the neighbour graph, never taken on trust —
  // otherwise a modified client could strike anywhere on the map.
  if (!match.reader.areNeighbours(from, to)) return fail(RejectReason.NotAdjacent);

  const defenderSlot = match.world.getOwner(to);
  if (defenderSlot !== OWNER_NONE) {
    const defender = match.players.get(defenderSlot);
    if (defender && defender.allianceId !== null && defender.allianceId === player.allianceId) {
      return fail(RejectReason.TargetIsAlly);
    }
  }

  const readyAt = cooldowns.get(from) ?? 0;
  if (now < readyAt) return fail(RejectReason.CooldownActive);

  const garrison = match.world.troops[from] as number;
  const committed = Math.floor(garrison * command.ratio);
  // A garrison must remain, or territories would flip back and forth with zero
  // defence and the map would become noise.
  if (committed < 1 || garrison - committed < COMBAT.garrisonMinimum) {
    return fail(RejectReason.InsufficientTroops);
  }

  return ok({ from, to, troops: committed });
}

/* -------------------------------------------------------------------------- */
/* Transfer                                                                    */
/* -------------------------------------------------------------------------- */

export function validateTransfer(
  match: MatchInstance,
  player: Player,
  command: TransferTroopsCommand,
): Result<{ from: number; to: number; troops: number }> {
  if (match.matchState !== MatchState.Running) return fail(RejectReason.MatchNotRunning);
  if (player.status !== PlayerStatus.Active) return fail(RejectReason.NotAPlayer);

  if (!isIntegerInRange(command.from, 0, match.world.territoryCount - 1)) {
    return fail(RejectReason.UnknownTerritory);
  }
  if (!isIntegerInRange(command.to, 0, match.world.territoryCount - 1)) {
    return fail(RejectReason.UnknownTerritory);
  }
  if (!isFiniteNumberInRange(command.ratio, 0.01, 1)) return fail(RejectReason.MalformedPacket);
  if (command.from === command.to) return fail(RejectReason.SelfTargeted);

  if (!match.world.isOwnedBy(command.from, player.slot)) return fail(RejectReason.NotOwner);

  // The destination must be yours or an ally's — reinforcing an enemy would be
  // an attack, which is a different command with different validation.
  const destinationOwner = match.world.getOwner(command.to);
  const isOwn = destinationOwner === player.slot;
  const destination = match.players.get(destinationOwner);
  const isAllied =
    destination !== undefined &&
    destination.allianceId !== null &&
    destination.allianceId === player.allianceId;
  if (!isOwn && !isAllied) return fail(RejectReason.NotOwner);

  if (!match.reader.areNeighbours(command.from, command.to)) return fail(RejectReason.NotAdjacent);

  const garrison = match.world.troops[command.from] as number;
  const moved = Math.floor(garrison * command.ratio);
  if (moved < 1 || garrison - moved < COMBAT.garrisonMinimum) {
    return fail(RejectReason.InsufficientTroops);
  }

  return ok({ from: command.from, to: command.to, troops: moved });
}

export function applyTransfer(
  match: MatchInstance,
  from: number,
  to: number,
  troops: number,
): void {
  match.world.setTroops(from, (match.world.troops[from] as number) - troops);
  match.world.setTroops(to, (match.world.troops[to] as number) + troops);
}
