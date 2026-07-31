import { createServer, type Server as HttpServer } from 'node:http';
import {
  OWNER_NONE,
  TerritoryField,
  decodeDelta,
  decodeSnapshot,
  type MatchInitPacket,
  type WorldDeltaPacket,
} from '@borderfall/shared';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MatchManager } from '../match/MatchManager.js';
import { MatchRouter } from './MatchRouter.js';
import { SocketGateway } from './SocketGateway.js';

/**
 * Full-stack multiplayer integration.
 *
 * Runs a real HTTP server, a real Socket.IO gateway and real client sockets.
 * Unit tests verify each layer in isolation; only this can prove the thing the
 * phase actually promises — that two independent clients converge on the same
 * authoritative world, and that a rejected command is rejected on the wire
 * rather than merely in a validator someone forgot to call.
 */

interface Harness {
  http: HttpServer;
  gateway: SocketGateway;
  router: MatchRouter;
  matches: MatchManager;
  port: number;
}

async function startHarness(): Promise<Harness> {
  const http = createServer();
  const gateway = new SocketGateway(http);
  const matches = new MatchManager();
  const router = new MatchRouter(matches);
  router.attach(gateway);

  // Port 0 lets the OS pick a free port, so parallel test files never collide.
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('No port assigned');

  return { http, gateway, router, matches, port: address.port };
}

async function stopHarness(harness: Harness): Promise<void> {
  harness.router.dispose();
  harness.matches.disposeAll();
  await harness.gateway.close();
  await new Promise<void>((resolve) => harness.http.close(() => resolve()));
}

function connect(port: number): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function join(socket: ClientSocket, roomId = ''): Promise<MatchInitPacket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join timed out')), 10_000);
    socket.emit('match:join', { seq: 1, roomId }, (response: unknown) => {
      clearTimeout(timer);
      if (response && typeof response === 'object' && 'mapParams' in response) {
        resolve(response as MatchInitPacket);
      } else {
        reject(new Error(`join rejected: ${JSON.stringify(response)}`));
      }
    });
  });
}

/** Resolves on the next matching event, or rejects on timeout. */
function nextEvent<T>(
  socket: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    const handler = (payload: T): void => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };

    socket.on(event, handler);
  });
}

describe('multiplayer integration', () => {
  let harness: Harness;
  const sockets: ClientSocket[] = [];

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
    await stopHarness(harness);
  });

  async function client(): Promise<ClientSocket> {
    const socket = await connect(harness.port);
    sockets.push(socket);
    return socket;
  }

  it('seats a joining player and sends a world they can rebuild', async () => {
    const socket = await client();
    const init = await join(socket);

    expect(init.yourSlot).toBeGreaterThanOrEqual(0);
    expect(init.reconnectToken).toBeTruthy();
    expect(init.mapParams.seed).toBeTypeOf('number');
    // The map itself is never transmitted — only the parameters to rebuild it.
    expect(init.snapshot.owner.length).toBeGreaterThan(0);
  });

  it('places two quick-play joiners in the same match', async () => {
    const a = await client();
    const b = await client();

    const initA = await join(a);
    const initB = await join(b);

    // Quick play must converge players, not scatter them across empty rooms.
    expect(initB.matchId).toBe(initA.matchId);
    expect(initB.yourSlot).not.toBe(initA.yourSlot);
  });

  it('grants each player a distinct starting territory', async () => {
    const a = await client();
    const b = await client();

    const initA = await join(a);
    await join(b);

    const match = harness.matches.getById(initA.matchId);
    expect(match).toBeDefined();
    if (!match) return;

    const ownedA: number[] = [];
    const ownedB: number[] = [];
    for (let id = 0; id < match.world.territoryCount; id++) {
      const owner = match.world.getOwner(id);
      if (owner === 0) ownedA.push(id);
      if (owner === 1) ownedB.push(id);
    }

    expect(ownedA.length).toBe(1);
    expect(ownedB.length).toBe(1);
    expect(ownedA[0]).not.toBe(ownedB[0]);
  });

  it('replicates one player’s conquest to the other', async () => {
    const a = await client();
    const b = await client();

    const initA = await join(a);
    await join(b);

    const match = harness.matches.getById(initA.matchId);
    if (!match) throw new Error('match missing');

    // Find A's territory and a neutral land neighbour to take.
    let source = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (match.world.getOwner(id) === initA.yourSlot) {
        source = id;
        break;
      }
    }
    expect(source).toBeGreaterThanOrEqual(0);

    let target = -1;
    const degree = match.reader.getNeighbourCount(source);
    for (let k = 0; k < degree; k++) {
      const neighbour = match.reader.getNeighbourAt(source, k);
      if (match.reader.isLand(neighbour) && match.world.isNeutral(neighbour)) {
        target = neighbour;
        break;
      }
    }
    if (target < 0) return; // Island spawn; nothing adjacent to take.

    match.world.setTroops(source, 500);

    // B must learn about a change it had no part in — this is the whole
    // point of authoritative replication. The packet is decoded first because
    // Socket.IO delivers typed arrays as Buffers; reading them raw yields
    // wrong values at every index but the first.
    const deltaPromise = nextEvent<WorldDeltaPacket>(b, 'world:delta', (raw) => {
      const packet = decodeDelta(raw);
      for (let i = 0; i < packet.ids.length; i++) {
        if (packet.ids[i] === target && (packet.fields[i]! & TerritoryField.Owner) !== 0) {
          return true;
        }
      }
      return false;
    });

    a.emit('cmd:attack', { seq: 2, from: source, to: target, ratio: 0.8 });

    const delta = decodeDelta(await deltaPromise);
    const index = Array.from(delta.ids).indexOf(target);
    expect(delta.owner[index]).toBe(initA.yourSlot);
    expect(match.world.getOwner(target)).toBe(initA.yourSlot);
  });

  it('delivers deltas whose decoded arrays match the server exactly', async () => {
    // Direct regression guard for the Socket.IO binary-view problem: a
    // Uint16Array arrives as a Buffer, so `.length` is the byte count and every
    // index past 0 reads the wrong half of a value.
    const a = await client();
    const init = await join(a);

    const match = harness.matches.getById(init.matchId);
    if (!match) throw new Error('match missing');

    const targets = [11, 22, 33, 44];
    for (const id of targets) match.world.setOwner(id, 5);

    const raw = await nextEvent<WorldDeltaPacket>(a, 'world:delta', (packet) => {
      const decoded = decodeDelta(packet);
      return Array.from(decoded.ids).includes(44);
    });

    const decoded = decodeDelta(raw);

    // The undecoded packet reports byte length; the decoded one reports
    // elements. If these were equal the decoder would not be doing anything.
    expect(decoded.ids.length).toBeLessThan((raw.ids as unknown as Uint8Array).length);

    for (const id of targets) {
      const index = Array.from(decoded.ids).indexOf(id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(decoded.owner[index]).toBe(5);
    }
  });

  it('sends an init snapshot that decodes to the correct world size', async () => {
    const a = await client();
    const init = await join(a);

    const match = harness.matches.getById(init.matchId);
    if (!match) throw new Error('match missing');

    const snapshot = decodeSnapshot(init.snapshot);
    expect(snapshot.owner.length).toBe(match.world.territoryCount);
    expect(snapshot.population.length).toBe(match.world.territoryCount);
    // The joining player's own spawn must be visible in their first snapshot.
    expect(Array.from(snapshot.owner)).toContain(init.yourSlot);
  });

  it('rejects an attack from a territory the client does not own', async () => {
    const a = await client();
    const initA = await join(a);

    const match = harness.matches.getById(initA.matchId);
    if (!match) throw new Error('match missing');

    // Pick a territory owned by nobody and try to attack from it.
    let notMine = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (match.world.getOwner(id) === OWNER_NONE && match.reader.isLand(id)) {
        notMine = id;
        break;
      }
    }
    expect(notMine).toBeGreaterThanOrEqual(0);

    const neighbour = match.reader.getNeighbourAt(notMine, 0);
    const responsePromise = nextEvent<{ seq: number; ok: boolean; reason?: number }>(
      a,
      'cmd:response',
      (payload) => payload.seq === 7,
    );

    a.emit('cmd:attack', { seq: 7, from: notMine, to: neighbour, ratio: 0.5 });

    const response = await responsePromise;
    expect(response.ok).toBe(false);
  });

  it('rejects an attack on a non-adjacent territory', async () => {
    const a = await client();
    const initA = await join(a);

    const match = harness.matches.getById(initA.matchId);
    if (!match) throw new Error('match missing');

    let source = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (match.world.getOwner(id) === initA.yourSlot) {
        source = id;
        break;
      }
    }

    let distant = -1;
    for (let id = 0; id < match.world.territoryCount; id++) {
      if (id !== source && match.reader.isLand(id) && !match.reader.areNeighbours(source, id)) {
        distant = id;
        break;
      }
    }

    match.world.setTroops(source, 500);

    const responsePromise = nextEvent<{ seq: number; ok: boolean }>(
      a,
      'cmd:response',
      (payload) => payload.seq === 11,
    );
    a.emit('cmd:attack', { seq: 11, from: source, to: distant, ratio: 0.5 });

    const response = await responsePromise;
    expect(response.ok).toBe(false);
    // The world must be untouched by a rejected command.
    expect(match.world.getOwner(distant)).not.toBe(initA.yourSlot);
  });

  it('sends private resource updates to each player', async () => {
    const a = await client();
    await join(a);

    const resources = await nextEvent<{ resources: { gold: number; territoryCount: number } }>(
      a,
      'player:resources',
    );

    expect(resources.resources.gold).toBeGreaterThan(0);
    expect(resources.resources.territoryCount).toBeGreaterThanOrEqual(1);
  });

  it('broadcasts the roster when a player joins', async () => {
    const a = await client();
    await join(a);

    const listPromise = nextEvent<{ players: unknown[] }>(
      a,
      'match:players',
      (packet) => packet.players.length >= 2,
    );

    const b = await client();
    await join(b);

    const list = await listPromise;
    expect(list.players.length).toBeGreaterThanOrEqual(2);
  });

  it('retains a disconnected player’s territories through the grace period', async () => {
    const a = await client();
    const b = await client();
    const initA = await join(a);
    await join(b);

    const match = harness.matches.getById(initA.matchId);
    if (!match) throw new Error('match missing');

    const before = match.world.totalsForSlot(initA.yourSlot).territories;
    expect(before).toBeGreaterThan(0);

    a.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Dropping an empire on a brief network blip would make a hiccup
    // unrecoverable and reward opponents for nothing.
    expect(match.world.totalsForSlot(initA.yourSlot).territories).toBe(before);
  });

  it('lets a player reclaim their slot with a reconnect token', async () => {
    const a = await client();
    const initA = await join(a);
    const token = initA.reconnectToken;

    a.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const rejoined = await client();
    const init = await new Promise<MatchInitPacket>((resolve, reject) => {
      rejoined.emit(
        'match:join',
        { seq: 1, roomId: initA.matchId, reconnectToken: token },
        (response: unknown) => {
          if (response && typeof response === 'object' && 'mapParams' in response) {
            resolve(response as MatchInitPacket);
          } else {
            reject(new Error('reconnect rejected'));
          }
        },
      );
    });

    expect(init.yourSlot).toBe(initA.yourSlot);
  });

  it('broadcasts standings including every player', async () => {
    // Regression guard: the leaderboard method existed but nothing called it,
    // so the panel stayed empty for the whole match.
    const a = await client();
    await join(a);

    const boardPromise = nextEvent<{ entries: Array<{ slot: number; name: string }> }>(
      a,
      'leaderboard:update',
      (packet) => packet.entries.length >= 2,
    );

    const b = await client();
    await join(b);

    const board = await boardPromise;
    expect(board.entries.length).toBeGreaterThanOrEqual(2);
    expect(board.entries.map((entry) => entry.slot)).toContain(0);
    expect(board.entries.map((entry) => entry.slot)).toContain(1);
  });

  it('ranks standings by score, highest first', async () => {
    const a = await client();
    const init = await join(a);
    const b = await client();
    await join(b);

    const match = harness.matches.getById(init.matchId);
    if (!match) throw new Error('match missing');

    // Give slot 1 a decisive territory lead.
    let granted = 0;
    for (let id = 0; id < match.world.territoryCount && granted < 10; id++) {
      if (match.reader.isLand(id) && match.world.isNeutral(id)) {
        match.world.setOwner(id, 1);
        granted++;
      }
    }

    const board = await nextEvent<{ entries: Array<{ slot: number; rank: number }> }>(
      a,
      'leaderboard:update',
      (packet) => packet.entries.length >= 2 && packet.entries[0]?.slot === 1,
    );

    expect(board.entries[0]?.slot).toBe(1);
    expect(board.entries[0]?.rank).toBe(1);
    expect(board.entries[1]?.rank).toBe(2);
  });

  it('serves a fresh snapshot on resync request', async () => {
    const a = await client();
    await join(a);

    const snapshotPromise = nextEvent<{ owner: Uint16Array }>(a, 'world:snapshot');
    a.emit('match:resync');

    const snapshot = await snapshotPromise;
    expect(snapshot.owner.length).toBeGreaterThan(0);
  });
});
