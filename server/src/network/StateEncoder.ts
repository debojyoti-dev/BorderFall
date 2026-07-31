import {
  TerritoryField,
  type WorldDeltaPacket,
  type WorldSnapshotPacket,
} from '@borderfall/shared';
import type { WorldState } from '../engine/WorldState.js';

/**
 * Serialises world state for the wire.
 *
 * Both packet shapes are parallel typed arrays rather than arrays of objects.
 * Socket.IO transmits typed arrays as binary attachments, so a delta of 40
 * changed territories costs roughly 400 bytes; the equivalent JSON array of
 * `{id, owner, population, troops}` objects is around 3 KB. At 20 Hz × 200
 * players that difference is 1.6 MB/s versus 12 MB/s of egress — the
 * difference between one server and several.
 *
 * The delta carries a `fields` bitmask per entry. Typed arrays cannot be
 * sparse, so every value array is fully populated; entries whose bit is unset
 * hold stale data the client must ignore. Sending only the used slots would
 * mean variable-length rows and a hand-rolled binary reader, which is not worth
 * the extra ~30 % for the complexity it adds to both sides.
 */

const ALL_FIELDS =
  TerritoryField.Owner |
  TerritoryField.Population |
  TerritoryField.Troops |
  TerritoryField.Building |
  TerritoryField.BuildingLevel |
  TerritoryField.Construction;

/**
 * Full state dump, used on join and as a periodic keyframe.
 *
 * Copies the arrays rather than passing references: the simulation keeps
 * mutating while this packet is queued for transmission, and Socket.IO
 * serialises asynchronously. Sharing the buffer would let a client receive a
 * snapshot torn across two ticks.
 */
export function encodeSnapshot(
  state: WorldState,
  tick: number,
  serverTime: number,
): WorldSnapshotPacket {
  return {
    tick,
    serverTime,
    owner: new Uint16Array(state.owner),
    population: new Uint32Array(state.population),
    troops: new Uint32Array(state.troops),
    building: new Uint8Array(state.building),
    buildingLevel: new Uint8Array(state.buildingLevel),
    construction: new Uint8Array(state.construction),
    // Ships and missiles arrive in phases 6 and 7. The fields exist now so the
    // client decoder is final and does not need reworking when they land.
    ships: [],
    missiles: [],
  };
}

/**
 * Incremental update covering everything changed since the last
 * {@link WorldState.clearDirty}.
 *
 * Returns `null` when nothing changed, so an idle match sends no traffic at all
 * rather than 20 empty packets a second to every connected player.
 */
export function encodeDelta(
  state: WorldState,
  tick: number,
  baseTick: number,
  serverTime: number,
): WorldDeltaPacket | null {
  const changed = state.changedIds();
  const count = changed.length;
  if (count === 0) return null;

  const ids = new Uint16Array(count);
  const fields = new Uint8Array(count);
  const owner = new Uint16Array(count);
  const population = new Uint32Array(count);
  const troops = new Uint32Array(count);
  const building = new Uint8Array(count);
  const buildingLevel = new Uint8Array(count);
  const construction = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const id = changed[i] as number;
    ids[i] = id;
    fields[i] = state.changedFields(id);

    // Every slot is written regardless of its bit. The client ignores the ones
    // the mask excludes; leaving them zero would be indistinguishable from a
    // real zero if a decoding bug ever dropped the mask check.
    owner[i] = state.owner[id] as number;
    population[i] = state.population[id] as number;
    troops[i] = state.troops[id] as number;
    building[i] = state.building[id] as number;
    buildingLevel[i] = state.buildingLevel[id] as number;
    construction[i] = state.construction[id] as number;
  }

  return {
    tick,
    baseTick,
    serverTime,
    ids,
    fields,
    owner,
    population,
    troops,
    building,
    buildingLevel,
    construction,
    ships: [],
    removedShips: [],
    missiles: [],
    removedMissiles: [],
  };
}

/** Approximate wire size of a delta, for the metrics counter. */
export function deltaByteLength(delta: WorldDeltaPacket): number {
  return (
    delta.ids.byteLength +
    delta.fields.byteLength +
    delta.owner.byteLength +
    delta.population.byteLength +
    delta.troops.byteLength +
    delta.building.byteLength +
    delta.buildingLevel.byteLength +
    delta.construction.byteLength
  );
}

export { ALL_FIELDS };
