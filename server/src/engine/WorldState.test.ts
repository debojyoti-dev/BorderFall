import { OWNER_NONE, TerritoryField, createMapParams, generateWorld } from '@borderfall/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorldState } from './WorldState.js';

const geometry = generateWorld(
  createMapParams(99, { territoryCount: 300, width: 2048, height: 2048 }),
);

describe('WorldState', () => {
  let state: WorldState;

  beforeEach(() => {
    state = new WorldState(geometry);
  });

  it('starts fully neutral and clean', () => {
    expect(state.getOwner(0)).toBe(OWNER_NONE);
    expect(state.isNeutral(0)).toBe(true);
    expect(state.changedCount).toBe(0);
  });

  it('records a dirty field on change', () => {
    state.setOwner(5, 3);
    expect(state.changedCount).toBe(1);
    expect(Array.from(state.changedIds())).toEqual([5]);
    expect(state.changedFields(5) & TerritoryField.Owner).toBeTruthy();
  });

  it('does not dirty on a write of the same value', () => {
    state.setOwner(5, 3);
    state.clearDirty();
    state.setOwner(5, 3);

    // Idle territories must not appear in deltas, or an unchanging match would
    // still broadcast the whole world 20 times a second.
    expect(state.changedCount).toBe(0);
  });

  it('lists a territory once even after several field changes', () => {
    state.setOwner(7, 1);
    state.setTroops(7, 50);
    state.setPopulation(7, 900);

    expect(state.changedCount).toBe(1);
    const fields = state.changedFields(7);
    expect(fields & TerritoryField.Owner).toBeTruthy();
    expect(fields & TerritoryField.Troops).toBeTruthy();
    expect(fields & TerritoryField.Population).toBeTruthy();
  });

  it('clears dirty state without touching values', () => {
    state.setOwner(2, 4);
    state.setTroops(2, 10);
    state.clearDirty();

    expect(state.changedCount).toBe(0);
    expect(state.changedFields(2)).toBe(0);
    expect(state.getOwner(2)).toBe(4);
    expect(state.troops[2]).toBe(10);
  });

  it('clamps negative and non-finite values instead of wrapping', () => {
    // A Uint32Array silently wraps a negative to ~4 billion, which would show
    // a bankrupt player as the richest on the leaderboard.
    state.setTroops(1, -50);
    expect(state.troops[1]).toBe(0);

    state.setPopulation(1, Number.NaN);
    expect(state.population[1]).toBe(0);

    state.setPopulation(1, Number.POSITIVE_INFINITY);
    expect(state.population[1]).toBe(0xffffffff);
  });

  it('quantises construction progress to a byte', () => {
    state.setConstruction(3, 0.5);
    expect(state.construction[3]).toBe(128);
    state.setConstruction(3, 1);
    expect(state.construction[3]).toBe(255);
    state.setConstruction(3, -1);
    expect(state.construction[3]).toBe(0);
  });

  it('counts territories per slot', () => {
    state.setOwner(0, 1);
    state.setOwner(1, 1);
    state.setOwner(2, 2);

    const counts = new Uint32Array(8);
    state.countTerritoriesBySlot(counts);
    expect(counts[1]).toBe(2);
    expect(counts[2]).toBe(1);
    expect(counts[0]).toBe(0);
  });

  it('aggregates totals for a slot', () => {
    state.setOwner(10, 5);
    state.setPopulation(10, 1000);
    state.setTroops(10, 40);
    state.setOwner(11, 5);
    state.setPopulation(11, 500);
    state.setTroops(11, 10);

    const totals = state.totalsForSlot(5);
    expect(totals.territories).toBe(2);
    expect(totals.population).toBe(1500);
    expect(totals.troops).toBe(50);
  });

  it('releases every territory held by a slot', () => {
    state.setOwner(20, 6);
    state.setOwner(21, 6);
    state.setTroops(20, 99);
    state.clearDirty();

    expect(state.releaseSlot(6)).toBe(2);
    expect(state.getOwner(20)).toBe(OWNER_NONE);
    expect(state.troops[20]).toBe(0);
    // Release must be visible to clients, so it dirties.
    expect(state.changedCount).toBeGreaterThan(0);
  });

  it('marks the whole world dirty for a forced resync', () => {
    state.markAllDirty();
    expect(state.changedCount).toBe(geometry.territoryCount);
  });

  it('does not overflow the dirty list when every territory changes', () => {
    for (let id = 0; id < geometry.territoryCount; id++) state.setOwner(id, 1);
    expect(state.changedCount).toBe(geometry.territoryCount);

    // Repeating must not append duplicates and overrun the fixed-size list.
    for (let id = 0; id < geometry.territoryCount; id++) state.setTroops(id, 5);
    expect(state.changedCount).toBe(geometry.territoryCount);
  });
});
