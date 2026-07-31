import {
  OWNER_NONE,
  TerritoryField,
  type BuildingType,
  type WorldGeometry,
} from '@borderfall/shared';

/**
 * The authoritative mutable world.
 *
 * Structure-of-arrays, paired with a dirty tracker. Two things make this the
 * shape it is:
 *
 * 1. **Iteration cost.** Simulation systems sweep every territory every tick.
 *    At 5 000 territories an array of objects costs a pointer dereference and a
 *    likely cache miss per entity per system per tick; parallel typed arrays
 *    stream contiguous memory.
 *
 * 2. **Delta extraction.** Broadcasting at 20 Hz to 200 players means the
 *    question "what changed since the last broadcast?" is asked 20 times a
 *    second and must be answered without scanning 5 000 entries. Every mutation
 *    goes through a setter that records the territory and the specific field,
 *    so extraction is O(changed) rather than O(world).
 *
 * The setters are the only way to mutate state. That is deliberate: a system
 * writing `state.owner[id] = slot` directly would silently skip dirty tracking,
 * and the resulting bug — a territory that changes hands on the server but
 * never on any client — is invisible until someone notices the map is wrong.
 */
export class WorldState {
  readonly territoryCount: number;

  /* Territory state -------------------------------------------------------- */
  readonly owner: Uint16Array;
  readonly population: Uint32Array;
  readonly troops: Uint32Array;
  readonly building: Uint8Array;
  readonly buildingLevel: Uint8Array;
  /** Construction progress, quantised 0-255 so it fits the wire format. */
  readonly construction: Uint8Array;
  /** 1 while an assault is resolving here, so clients can flag it visually. */
  readonly contested: Uint8Array;

  /* Dirty tracking --------------------------------------------------------- */

  /** Changed-field bitmask per territory; 0 means clean. */
  private readonly dirtyFields: Uint8Array;
  /**
   * Compact list of dirty territory ids.
   *
   * Sized to the whole world so it can never overflow, even if every territory
   * changes in one tick (a MIRV strike comes close). Membership is tested via
   * `dirtyFields`, so an id is appended at most once per tick.
   */
  private readonly dirtyList: Uint16Array;
  private dirtyCount = 0;

  constructor(readonly geometry: WorldGeometry) {
    this.territoryCount = geometry.territoryCount;

    this.owner = new Uint16Array(this.territoryCount).fill(OWNER_NONE);
    this.population = new Uint32Array(this.territoryCount);
    this.troops = new Uint32Array(this.territoryCount);
    this.building = new Uint8Array(this.territoryCount);
    this.buildingLevel = new Uint8Array(this.territoryCount);
    this.construction = new Uint8Array(this.territoryCount);
    this.contested = new Uint8Array(this.territoryCount);

    this.dirtyFields = new Uint8Array(this.territoryCount);
    this.dirtyList = new Uint16Array(this.territoryCount);
  }

  /* Mutators --------------------------------------------------------------- */

  setOwner(id: number, slot: number): void {
    if (this.owner[id] === slot) return;
    this.owner[id] = slot;
    this.markDirty(id, TerritoryField.Owner);
  }

  setPopulation(id: number, value: number): void {
    // Clamp rather than trust: population is derived from float growth maths,
    // and a NaN or negative reaching a Uint32Array wraps to a huge number.
    const clamped = value > 0 ? Math.min(0xffffffff, Math.round(value)) : 0;
    if (this.population[id] === clamped) return;
    this.population[id] = clamped;
    this.markDirty(id, TerritoryField.Population);
  }

  setTroops(id: number, value: number): void {
    const clamped = value > 0 ? Math.min(0xffffffff, Math.round(value)) : 0;
    if (this.troops[id] === clamped) return;
    this.troops[id] = clamped;
    this.markDirty(id, TerritoryField.Troops);
  }

  setBuilding(id: number, type: BuildingType, level: number): void {
    let changed = false;
    if (this.building[id] !== type) {
      this.building[id] = type;
      this.markDirty(id, TerritoryField.Building);
      changed = true;
    }
    const clampedLevel = Math.max(0, Math.min(255, Math.round(level)));
    if (this.buildingLevel[id] !== clampedLevel) {
      this.buildingLevel[id] = clampedLevel;
      this.markDirty(id, TerritoryField.BuildingLevel);
      changed = true;
    }
    if (!changed) return;
  }

  /** `progress` is 0-1; stored quantised to a byte. */
  setConstruction(id: number, progress: number): void {
    const quantised = Math.max(0, Math.min(255, Math.round(progress * 255)));
    if (this.construction[id] === quantised) return;
    this.construction[id] = quantised;
    this.markDirty(id, TerritoryField.Construction);
  }

  setContested(id: number, value: boolean): void {
    const flag = value ? 1 : 0;
    if (this.contested[id] === flag) return;
    this.contested[id] = flag;
    this.markDirty(id, TerritoryField.Contested);
  }

  /* Accessors -------------------------------------------------------------- */

  getOwner(id: number): number {
    return this.owner[id] as number;
  }

  isOwnedBy(id: number, slot: number): boolean {
    return this.owner[id] === slot;
  }

  isNeutral(id: number): boolean {
    return this.owner[id] === OWNER_NONE;
  }

  /* Dirty tracking --------------------------------------------------------- */

  private markDirty(id: number, field: number): void {
    if (this.dirtyFields[id] === 0) {
      this.dirtyList[this.dirtyCount++] = id;
    }
    this.dirtyFields[id] = (this.dirtyFields[id] as number) | field;
  }

  get changedCount(): number {
    return this.dirtyCount;
  }

  /** Territory ids changed since the last {@link clearDirty}. */
  changedIds(): Uint16Array {
    return this.dirtyList.subarray(0, this.dirtyCount);
  }

  changedFields(id: number): number {
    return this.dirtyFields[id] as number;
  }

  clearDirty(): void {
    for (let i = 0; i < this.dirtyCount; i++) {
      this.dirtyFields[this.dirtyList[i] as number] = 0;
    }
    this.dirtyCount = 0;
  }

  /**
   * Marks every territory fully dirty.
   *
   * Used when a client needs a resync mid-match without the cost of a bespoke
   * code path — the next delta simply carries everything.
   */
  markAllDirty(): void {
    this.dirtyCount = 0;
    const all =
      TerritoryField.Owner |
      TerritoryField.Population |
      TerritoryField.Troops |
      TerritoryField.Building |
      TerritoryField.BuildingLevel |
      TerritoryField.Construction;
    for (let id = 0; id < this.territoryCount; id++) {
      this.dirtyFields[id] = all;
      this.dirtyList[this.dirtyCount++] = id;
    }
  }

  /* Aggregates ------------------------------------------------------------- */

  /**
   * Territory count per player slot, written into `out`.
   *
   * Takes an output buffer because the leaderboard recomputes this every two
   * seconds for the lifetime of a match; allocating a fresh array each time is
   * needless garbage.
   */
  countTerritoriesBySlot(out: Uint32Array): void {
    out.fill(0);
    for (let id = 0; id < this.territoryCount; id++) {
      const slot = this.owner[id] as number;
      if (slot !== OWNER_NONE && slot < out.length) out[slot]!++;
    }
  }

  /** Total population and troops held by one slot. */
  totalsForSlot(slot: number): { population: number; troops: number; territories: number } {
    let population = 0;
    let troops = 0;
    let territories = 0;
    for (let id = 0; id < this.territoryCount; id++) {
      if (this.owner[id] !== slot) continue;
      population += this.population[id] as number;
      troops += this.troops[id] as number;
      territories++;
    }
    return { population, troops, territories };
  }

  /** Releases every territory held by a slot. Used on elimination or leave. */
  releaseSlot(slot: number): number {
    let released = 0;
    for (let id = 0; id < this.territoryCount; id++) {
      if (this.owner[id] !== slot) continue;
      this.setOwner(id, OWNER_NONE);
      this.setTroops(id, 0);
      released++;
    }
    return released;
  }
}
