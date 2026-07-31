import { TerritoryField, createMapParams, generateWorld } from '@borderfall/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorldState } from '../engine/WorldState.js';
import { encodeDelta, encodeSnapshot } from './StateEncoder.js';

const geometry = generateWorld(
  createMapParams(21, { territoryCount: 300, width: 2048, height: 2048 }),
);

/** Mirrors the client's decoder, so the round trip is genuinely exercised. */
function applyDelta(
  mirror: { owner: Uint16Array; troops: Uint32Array; population: Uint32Array },
  delta: NonNullable<ReturnType<typeof encodeDelta>>,
): void {
  for (let i = 0; i < delta.ids.length; i++) {
    const id = delta.ids[i]!;
    const fields = delta.fields[i]!;
    if (fields & TerritoryField.Owner) mirror.owner[id] = delta.owner[i]!;
    if (fields & TerritoryField.Troops) mirror.troops[id] = delta.troops[i]!;
    if (fields & TerritoryField.Population) mirror.population[id] = delta.population[i]!;
  }
}

describe('StateEncoder', () => {
  let state: WorldState;

  beforeEach(() => {
    state = new WorldState(geometry);
  });

  it('returns null when nothing changed', () => {
    // An idle match must produce no traffic at all, rather than 20 empty
    // packets a second to every connected player.
    expect(encodeDelta(state, 10, 9, Date.now())).toBeNull();
  });

  it('encodes only changed territories', () => {
    state.setOwner(4, 2);
    state.setTroops(9, 30);

    const delta = encodeDelta(state, 5, 4, 1000);
    expect(delta).not.toBeNull();
    expect(delta!.ids.length).toBe(2);
    expect(Array.from(delta!.ids).sort((a, b) => a - b)).toEqual([4, 9]);
  });

  it('sets a field bit only for fields that actually changed', () => {
    state.setTroops(3, 12);

    const delta = encodeDelta(state, 1, 0, 0)!;
    const index = Array.from(delta.ids).indexOf(3);
    const fields = delta.fields[index]!;

    expect(fields & TerritoryField.Troops).toBeTruthy();
    expect(fields & TerritoryField.Owner).toBeFalsy();
    expect(fields & TerritoryField.Population).toBeFalsy();
  });

  it('round-trips through a client-style decoder', () => {
    const mirror = {
      owner: new Uint16Array(geometry.territoryCount).fill(0xffff),
      troops: new Uint32Array(geometry.territoryCount),
      population: new Uint32Array(geometry.territoryCount),
    };

    state.setOwner(11, 3);
    state.setTroops(11, 77);
    state.setPopulation(12, 4321);

    applyDelta(mirror, encodeDelta(state, 1, 0, 0)!);

    expect(mirror.owner[11]).toBe(3);
    expect(mirror.troops[11]).toBe(77);
    expect(mirror.population[12]).toBe(4321);
    // Territory 12's owner was untouched, so the mirror must keep its own.
    expect(mirror.owner[12]).toBe(0xffff);
  });

  it('converges on the server state over a sequence of deltas', () => {
    const mirror = {
      owner: new Uint16Array(geometry.territoryCount).fill(0xffff),
      troops: new Uint32Array(geometry.territoryCount),
      population: new Uint32Array(geometry.territoryCount),
    };

    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 15; i++) {
        const id = (round * 15 + i) % geometry.territoryCount;
        state.setOwner(id, (round % 5) + 1);
        state.setTroops(id, round * 10 + i);
      }

      const delta = encodeDelta(state, round + 1, round, 0);
      if (delta) applyDelta(mirror, delta);
      state.clearDirty();
    }

    // The whole point of delta replication: after replaying every delta, the
    // mirror must equal the authoritative state exactly.
    expect(Array.from(mirror.owner)).toEqual(Array.from(state.owner));
    expect(Array.from(mirror.troops)).toEqual(Array.from(state.troops));
  });

  it('produces a snapshot that copies rather than aliases the live arrays', () => {
    state.setOwner(1, 7);
    const snapshot = encodeSnapshot(state, 3, 100);
    expect(snapshot.owner[1]).toBe(7);

    // The simulation keeps mutating while a packet is queued for transmission;
    // sharing the buffer would let a client receive a torn snapshot.
    state.setOwner(1, 8);
    expect(snapshot.owner[1]).toBe(7);
  });

  it('carries the base tick so clients can detect a gap', () => {
    state.setOwner(2, 1);
    const delta = encodeDelta(state, 42, 41, 0)!;
    expect(delta.tick).toBe(42);
    expect(delta.baseTick).toBe(41);
  });

  it('stays far smaller than a snapshot for a small change', () => {
    state.setOwner(0, 1);
    const delta = encodeDelta(state, 1, 0, 0)!;
    const snapshot = encodeSnapshot(state, 1, 0);

    const deltaBytes = delta.ids.byteLength + delta.fields.byteLength + delta.owner.byteLength;
    const snapshotBytes = snapshot.owner.byteLength + snapshot.population.byteLength;

    expect(deltaBytes).toBeLessThan(snapshotBytes / 50);
  });
});
