import type {
  BuildingCompletedEvent,
  CombatResolvedEvent,
  MissileImpactEvent,
  MissileLaunchedEvent,
  PlayerEliminatedEvent,
  TerritoryCapturedEvent,
} from '@borderfall/shared';

/**
 * The internal simulation event catalogue.
 *
 * Distinct from the Socket.IO event map on purpose. Many of these never leave
 * the server (`sim:tick`, `economy:bankrupt`), and some carry richer detail
 * than clients are allowed to see. The network layer is simply *one more
 * subscriber* to this bus — it listens, filters by what each player may know,
 * and forwards. That inversion is what keeps the simulation entirely unaware of
 * networking, which in turn is what makes it runnable head-less inside a replay
 * or a load test.
 */
export interface SimulationEventMap {
  /* Lifecycle ------------------------------------------------------------- */
  'sim:started': { matchId: string; startedAt: number };
  'sim:tick': { tick: number; elapsedMs: number };
  'sim:ended': { matchId: string; winnerSlot: number | null; durationMs: number };

  /* Players --------------------------------------------------------------- */
  'player:joined': { slot: number; name: string; isBot: boolean };
  'player:left': { slot: number; surrendered: boolean };
  'player:reconnected': { slot: number };
  'player:disconnected': { slot: number; graceExpiresAt: number };
  'player:eliminated': PlayerEliminatedEvent;

  /* Territory ------------------------------------------------------------- */
  'territory:captured': TerritoryCapturedEvent;
  /** Emitted for every ownership change including bloodless transfers. */
  'territory:owner-changed': { territory: number; from: number; to: number };

  /* Combat ---------------------------------------------------------------- */
  'combat:resolved': CombatResolvedEvent;
  'combat:attack-launched': {
    from: number;
    to: number;
    attackerSlot: number;
    troops: number;
    arrivesAt: number;
  };

  /* Economy --------------------------------------------------------------- */
  'economy:income': { slot: number; gold: number; food: number };
  /** Upkeep exceeded reserves; the economy system is disbanding assets. */
  'economy:bankrupt': { slot: number; deficit: number };
  'economy:trade': { from: number; to: number; gold: number; food: number; isLoan: boolean };

  /* Buildings ------------------------------------------------------------- */
  'building:started': { territory: number; building: number; level: number; slot: number };
  'building:completed': BuildingCompletedEvent;
  'building:destroyed': { territory: number; building: number; slot: number };

  /* Navy ------------------------------------------------------------------ */
  'ship:spawned': { shipId: number; slot: number; shipType: number };
  'ship:destroyed': { shipId: number; slot: number; bySlot: number };
  'ship:arrived': { shipId: number; territory: number };

  /* Missiles -------------------------------------------------------------- */
  'missile:launched': MissileLaunchedEvent;
  'missile:impact': MissileImpactEvent;
  'missile:intercepted': { missileId: number; bySlot: number; territory: number };

  /* Diplomacy ------------------------------------------------------------- */
  'alliance:formed': { allianceId: number; slots: readonly number[] };
  'alliance:member-joined': { allianceId: number; slot: number };
  'alliance:member-left': { allianceId: number; slot: number; kicked: boolean };
  'alliance:dissolved': { allianceId: number };
  'diplomacy:war-declared': { from: number; to: number };

  /* Presentation ---------------------------------------------------------- */
  'leaderboard:updated': { tick: number };
  'chat:message': {
    channel: number;
    senderSlot: number;
    text: string;
    targetSlot: number | null;
  };
}

export type SimulationEventName = keyof SimulationEventMap;
