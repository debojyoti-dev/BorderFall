import { OWNER_NONE, WorldReader } from '@borderfall/shared';
import type { MatchClient } from './MatchClient.js';

/**
 * Test-only helper surface, exposed on `window.__borderfall`.
 *
 * Exists so end-to-end tests can issue a *legal* command without replicating
 * the world generator inside the test to work out which pixel to click.
 *
 * This grants no capability a player does not already have: the socket is
 * reachable from the console regardless, and every command it sends is
 * validated server-side exactly like any other. It is a convenience for
 * driving the UI, not a privileged channel — which is precisely the property
 * an authoritative server is supposed to guarantee.
 */
export interface BorderfallDebug {
  /** Attacks one adjacent neutral territory. Returns false if none is available. */
  expandOnce(): boolean;
  /** Territories currently held by the local player. */
  myTerritories(): number[];
  mySlot(): number;
  /**
   * Fingerprint of this client's replicated world.
   *
   * Two clients in the same match must agree on all of it. Comparing this is a
   * far stronger check of replication than comparing screenshots, and unlike
   * pixels it is independent of where each player's camera happens to point.
   */
  worldSignature(): { seed: number; territories: number; ownerHash: string };
}

export function installDebugHooks(match: MatchClient): void {
  const api: BorderfallDebug = {
    mySlot: () => match.mySlot,

    worldSignature: () => {
      // FNV-1a over the owner array. Not cryptographic — it only needs to
      // change whenever any ownership changes, and to be cheap enough to call
      // repeatedly while polling.
      let hash = 0x811c9dc5;
      for (let i = 0; i < match.owner.length; i++) {
        hash ^= match.owner[i] as number;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return {
        seed: match.geometry?.params.seed ?? -1,
        territories: match.owner.length,
        ownerHash: hash.toString(16),
      };
    },

    myTerritories: () => {
      const owned: number[] = [];
      for (let id = 0; id < match.owner.length; id++) {
        if (match.owner[id] === match.mySlot) owned.push(id);
      }
      return owned;
    },

    expandOnce: () => {
      if (!match.geometry || match.mySlot < 0) return false;
      const reader = new WorldReader(match.geometry);

      for (let id = 0; id < match.owner.length; id++) {
        if (match.owner[id] !== match.mySlot) continue;
        // Leave a garrison behind; the server rejects committing everything.
        if ((match.troops[id] ?? 0) < 4) continue;

        const degree = reader.getNeighbourCount(id);
        for (let k = 0; k < degree; k++) {
          const neighbour = reader.getNeighbourAt(id, k);
          if (!reader.isLand(neighbour)) continue;
          if (match.owner[neighbour] !== OWNER_NONE) continue;

          match.attack(id, neighbour, 0.6);
          return true;
        }
      }
      return false;
    },
  };

  (window as unknown as { __borderfall: BorderfallDebug }).__borderfall = api;
}
