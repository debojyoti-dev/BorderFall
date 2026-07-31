import { TILE_OWNER_NONE, type TileMap, type TileRef } from './TileMap.js';

/**
 * Mutable game state layered over a {@link TileMap}.
 *
 * Owns the two things the tile model changes fundamentally from the region
 * model:
 *
 * 1. **Troops are a single pool per player**, not a garrison per region. With
 *    hundreds of thousands of owned tiles, per-tile garrisons are neither
 *    representable nor playable — nobody is going to manage half a million
 *    stacks. One pool, spent as a fraction on each attack, is what makes the
 *    tile model tractable as a *game* rather than only as a renderer.
 *
 * 2. **Border tiles are tracked incrementally.** Conquest only ever examines
 *    the frontier, and rescanning a two-million-tile map to find it would cost
 *    more than the conquest itself. Every ownership change updates the border
 *    sets of the tiles involved and their neighbours, which is O(1) amortised.
 */

export interface TilePlayerState {
  readonly slot: number;
  troops: number;
  gold: number;
  tilesOwned: number;
  /** Frontier tiles — those adjacent to a tile this player does not own. */
  readonly borderTiles: Set<TileRef>;
}

export class TileWorld {
  private readonly players = new Map<number, TilePlayerState>();

  /**
   * Tiles whose ownership changed since the last drain.
   *
   * The renderer needs exactly this to update its texture, and the network
   * layer needs it to build deltas. A Set rather than an array so a tile
   * flipping twice in one tick is reported once.
   */
  private readonly dirtyTiles = new Set<TileRef>();

  constructor(readonly map: TileMap) {}

  /* Players ---------------------------------------------------------------- */

  addPlayer(slot: number, troops: number, gold: number): TilePlayerState {
    const state: TilePlayerState = {
      slot,
      troops,
      gold,
      tilesOwned: 0,
      borderTiles: new Set<TileRef>(),
    };
    this.players.set(slot, state);
    return state;
  }

  player(slot: number): TilePlayerState | undefined {
    return this.players.get(slot);
  }

  allPlayers(): TilePlayerState[] {
    return [...this.players.values()];
  }

  removePlayer(slot: number): void {
    const state = this.players.get(slot);
    if (!state) return;

    // Release the land before dropping the record, so border bookkeeping for
    // the surrounding players stays correct.
    for (let ref = 0; ref < this.map.tileCount; ref++) {
      if (this.map.ownerOf(ref) === slot) this.setOwner(ref, TILE_OWNER_NONE);
    }
    this.players.delete(slot);
  }

  /* Ownership -------------------------------------------------------------- */

  /**
   * Transfers a tile, maintaining tile counts and border sets.
   *
   * This is the only sanctioned way to change ownership. Writing
   * `map.owner[ref] = slot` directly would leave the border sets stale, and a
   * stale frontier means conquest silently stops advancing along that edge —
   * a bug that looks like a balance problem rather than a data problem.
   */
  setOwner(ref: TileRef, slot: number): void {
    const previous = this.map.ownerOf(ref);
    if (previous === slot) return;

    if (previous !== TILE_OWNER_NONE) {
      const owner = this.players.get(previous);
      if (owner) {
        owner.tilesOwned--;
        owner.borderTiles.delete(ref);
      }
    }

    this.map.setOwner(ref, slot);

    if (slot !== TILE_OWNER_NONE) {
      const owner = this.players.get(slot);
      if (owner) owner.tilesOwned++;
    }

    this.dirtyTiles.add(ref);

    // The tile itself and each cardinal neighbour may have gained or lost
    // frontier status as a result of this change.
    this.refreshBorder(ref);
    this.map.forEachNeighbour(ref, (neighbour) => this.refreshBorder(neighbour));
  }

  /** Recomputes whether one tile belongs in its owner's border set. */
  private refreshBorder(ref: TileRef): void {
    const slot = this.map.ownerOf(ref);
    if (slot === TILE_OWNER_NONE) return;

    const state = this.players.get(slot);
    if (!state) return;

    if (this.map.isBorder(ref)) state.borderTiles.add(ref);
    else state.borderTiles.delete(ref);
  }

  /* Dirty tracking --------------------------------------------------------- */

  get changedCount(): number {
    return this.dirtyTiles.size;
  }

  /** Returns the changed tiles and clears the set. */
  drainDirty(): TileRef[] {
    const changed = [...this.dirtyTiles];
    this.dirtyTiles.clear();
    return changed;
  }

  clearDirty(): void {
    this.dirtyTiles.clear();
  }

  /* Queries ---------------------------------------------------------------- */

  /** Territory share of the habitable world, 0–1. */
  territoryShare(slot: number): number {
    const state = this.players.get(slot);
    if (!state) return 0;
    return state.tilesOwned / Math.max(1, this.map.numLandTiles);
  }

  /**
   * Border tiles of `slot` that touch `target`.
   *
   * The frontier along which an attack can actually advance. Attacking through
   * a one-tile chokepoint and attacking across an open plain are the same
   * command; this is what makes them different outcomes.
   */
  frontierAgainst(slot: number, target: number, out: TileRef[]): TileRef[] {
    out.length = 0;
    const state = this.players.get(slot);
    if (!state) return out;

    for (const ref of state.borderTiles) {
      let touches = false;
      this.map.forEachNeighbour(ref, (neighbour) => {
        if (!touches && this.map.ownerOf(neighbour) === target) touches = true;
      });
      if (touches) out.push(ref);
    }
    return out;
  }
}
