import { createServer, type Server as HttpServer } from 'node:http';
import {
  IntentType,
  TILE_OWNER_NONE,
  TileGame,
  type Intent,
  type LockstepStartPacket,
  type Turn,
} from '@borderfall/shared';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockstepRouter } from './LockstepRouter.js';

/**
 * Lockstep integration.
 *
 * The claim under test is the one the whole architecture rests on: two
 * independent clients, each running their own simulation, fed the same turn
 * stream by a server that simulates nothing, converge on identical worlds.
 */

interface Harness {
  http: HttpServer;
  router: LockstepRouter;
  port: number;
}

async function startHarness(): Promise<Harness> {
  const http = createServer();
  const router = new LockstepRouter(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { http, router, port: address.port };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.router.close();
  await new Promise<void>((resolve) => harness.http.close(() => resolve()));
}

function connect(port: number): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      path: '/lockstep/',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function join(socket: ClientSocket, roomId = ''): Promise<LockstepStartPacket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join timed out')), 8000);
    socket.emit('lockstep:join', { roomId }, (response: unknown) => {
      clearTimeout(timer);
      if (response && typeof response === 'object' && 'seed' in response) {
        resolve(response as LockstepStartPacket);
      } else {
        reject(new Error(`join rejected: ${JSON.stringify(response)}`));
      }
    });
  });
}

/**
 * A client: a simulation plus the turn plumbing around it.
 *
 * Mirrors what the browser client will do — build the world from the seed,
 * fast-forward through history, then apply turns as they arrive.
 */
class TestClient {
  readonly game: TileGame;
  private nextExpected: number;

  constructor(
    readonly socket: ClientSocket,
    readonly start: LockstepStartPacket,
  ) {
    this.game = new TileGame({
      seed: start.seed,
      width: start.width,
      height: start.height,
      turnsPerSecond: start.turnsPerSecond,
    });

    for (const info of start.players) {
      this.game.addPlayer(info.slot, info.name, info.isBot);
    }

    // Replay history, filling the gaps the server omitted.
    this.nextExpected = 1;
    for (const turn of start.history) {
      this.fillTo(turn.turn - 1);
      this.game.applyTurn(turn);
      this.nextExpected = turn.turn + 1;
    }
    this.fillTo(start.currentTurn);

    socket.on('lockstep:turn', (turn: Turn) => this.onTurn(turn));
    socket.on('lockstep:players', (players: LockstepStartPacket['players']) => {
      for (const info of players) {
        if (!this.game.player(info.slot)) {
          this.game.addPlayer(info.slot, info.name, info.isBot);
        }
      }
    });
  }

  /** Applies empty turns up to and including `target`. */
  private fillTo(target: number): void {
    while (this.nextExpected <= target) {
      this.game.applyTurn({ turn: this.nextExpected, intents: [] });
      this.nextExpected++;
    }
  }

  /** Checksum after each turn, so convergence can be compared without racing. */
  readonly checksums = new Map<number, number>();
  private recording = false;

  recordChecksums(): void {
    this.recording = true;
  }

  private onTurn(turn: Turn): void {
    if (turn.turn < this.nextExpected) return; // Duplicate.
    this.fillTo(turn.turn - 1);
    this.game.applyTurn(turn);
    this.nextExpected = turn.turn + 1;
    if (this.recording) this.checksums.set(turn.turn, this.game.checksum());
  }

  send(intent: Omit<Intent, 'slot'>): void {
    this.socket.emit('lockstep:intent', intent);
  }

  get turn(): number {
    return this.game.turn;
  }
}

/** Waits until a predicate holds, or throws. */
async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met within timeout');
}

describe('lockstep relay', () => {
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

  async function client(roomId = ''): Promise<TestClient> {
    const socket = await connect(harness.port);
    sockets.push(socket);
    return new TestClient(socket, await join(socket, roomId));
  }

  it('sends the map parameters rather than the map', async () => {
    const c = await client();
    expect(c.start.seed).toBeTypeOf('number');
    expect(c.start.width).toBeGreaterThan(0);
    expect(c.start.turnsPerSecond).toBeGreaterThan(0);
    // Nothing resembling terrain or ownership is in the payload.
    expect(Object.keys(c.start)).not.toContain('terrain');
    expect(Object.keys(c.start)).not.toContain('owner');
  });

  it('advances turns on a clock even with no activity', async () => {
    // The empty turn is the heartbeat. Skipping it would stall every client.
    const c = await client();
    const start = c.turn;
    await until(() => c.turn > start + 3);
    expect(c.turn).toBeGreaterThan(start + 3);
  });

  it('places two quick-join clients in the same match', async () => {
    const a = await client();
    const b = await client();
    expect(b.start.matchId).toBe(a.start.matchId);
    expect(b.start.yourSlot).not.toBe(a.start.yourSlot);
  });

  it('stamps the sender’s slot onto intents', async () => {
    // The one thing a relay must enforce: a client cannot act as another
    // player. A forged intent is legal input that every peer would replay.
    const a = await client();
    const b = await client();

    let seen: Intent | null = null;
    b.socket.on('lockstep:turn', (turn: Turn) => {
      for (const intent of turn.intents) {
        if (intent.type === IntentType.Attack) seen = intent;
      }
    });

    // A claims to be player 99.
    a.socket.emit('lockstep:intent', {
      type: IntentType.Attack,
      target: TILE_OWNER_NONE,
      ratio: 0.5,
      slot: 99,
    } as unknown as Omit<Intent, 'slot'>);

    await until(() => seen !== null);
    expect(seen!.slot).toBe(a.start.yourSlot);
    expect(seen!.slot).not.toBe(99);
  });

  it('relays an intent to every client in the match', async () => {
    const a = await client();
    const b = await client();

    let received = 0;
    b.socket.on('lockstep:turn', (turn: Turn) => {
      received += turn.intents.length;
    });

    a.send({ type: IntentType.Attack, target: TILE_OWNER_NONE, ratio: 0.4 });
    await until(() => received > 0);
    expect(received).toBeGreaterThan(0);
  });

  it('converges two independent simulations on the same world', async () => {
    /**
     * The property the entire architecture rests on.
     *
     * Comparing live state would race: the two clients are momentarily on
     * different turns depending on packet arrival, so a direct comparison
     * would be flaky and — worse — would silently pass by skipping the check.
     * Instead each client records its checksum *per turn* as it goes, and the
     * comparison happens afterwards at every turn both actually reached.
     */
    const a = await client();
    const b = await client();

    a.recordChecksums();
    b.recordChecksums();

    a.send({ type: IntentType.Spawn, tile: findFreeLand(a.game, 0) });
    b.send({ type: IntentType.Spawn, tile: findFreeLand(a.game, 4000) });
    await until(() => a.game.player(a.start.yourSlot)!.hasSpawned);

    a.send({ type: IntentType.Attack, target: TILE_OWNER_NONE, ratio: 0.6 });
    b.send({ type: IntentType.Attack, target: TILE_OWNER_NONE, ratio: 0.6 });

    const target = Math.max(a.turn, b.turn) + 40;
    await until(() => a.turn >= target && b.turn >= target, 15_000);

    const shared = [...a.checksums.keys()].filter((turn) => b.checksums.has(turn));
    expect(shared.length).toBeGreaterThan(20);

    for (const turn of shared) {
      expect(b.checksums.get(turn), `divergence at turn ${turn}`).toBe(a.checksums.get(turn));
    }

    // And both actually played, rather than converging on an empty world.
    expect(a.game.player(a.start.yourSlot)!.tilesOwned).toBeGreaterThan(1);
    expect(b.game.player(b.start.yourSlot)!.tilesOwned).toBeGreaterThan(1);
  });

  it('catches a late joiner up through history', async () => {
    const a = await client();

    a.send({ type: IntentType.Spawn, tile: findFreeLand(a.game, 0) });
    await until(() => a.game.player(a.start.yourSlot)!.hasSpawned);
    await until(() => a.turn > 20);

    // B joins mid-match and must arrive at the same world.
    const b = await client(a.start.matchId);

    expect(b.start.currentTurn).toBeGreaterThan(10);
    expect(b.start.history.length).toBeGreaterThan(0);
    // The late joiner replayed history, so A's spawn is present in B's world.
    expect(b.game.player(a.start.yourSlot)?.hasSpawned).toBe(true);
  });

  it('omits empty turns from history', async () => {
    const a = await client();
    await until(() => a.turn > 25);

    const b = await client(a.start.matchId);
    // Twenty-five turns elapsed with no intents, so history stays empty while
    // currentTurn advances. Sending every empty turn would be ~100x larger.
    expect(b.start.currentTurn).toBeGreaterThan(20);
    expect(b.start.history).toHaveLength(0);
  });

  it('reports a desync when clients disagree', async () => {
    const a = await client();
    const b = await client();

    let desync: { turn: number; divergentSlots: number[] } | null = null;
    a.socket.on('lockstep:desync', (packet: { turn: number; divergentSlots: number[] }) => {
      desync = packet;
    });

    // Two honest reports plus one lie.
    a.socket.emit('lockstep:checksum', { turn: 5, checksum: 111 });
    b.socket.emit('lockstep:checksum', { turn: 5, checksum: 222 });

    await until(() => desync !== null);
    expect(desync!.turn).toBe(5);
    expect(desync!.divergentSlots.length).toBeGreaterThan(0);
  });

  it('stays silent when clients agree', async () => {
    const a = await client();
    const b = await client();

    let desync = false;
    a.socket.on('lockstep:desync', () => {
      desync = true;
    });

    a.socket.emit('lockstep:checksum', { turn: 5, checksum: 777 });
    b.socket.emit('lockstep:checksum', { turn: 5, checksum: 777 });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(desync).toBe(false);
  });

  it('keeps a disconnected player’s slot and territory', async () => {
    const a = await client();
    const b = await client();

    a.send({ type: IntentType.Spawn, tile: findFreeLand(a.game, 0) });
    await until(() => b.game.player(a.start.yourSlot)!.hasSpawned);

    const owned = b.game.player(a.start.yourSlot)!.tilesOwned;
    a.socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // There is no territory for the server to release — every client's
    // simulation owns the world, so a dropped player simply stops acting.
    expect(b.game.player(a.start.yourSlot)!.tilesOwned).toBe(owned);
  });

  it('lets a player reclaim their slot with a reconnect token', async () => {
    const a = await client();
    const slot = a.start.yourSlot;
    const token = a.start.reconnectToken;
    const matchId = a.start.matchId;

    a.socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const socket = await connect(harness.port);
    sockets.push(socket);
    const rejoined = await new Promise<LockstepStartPacket>((resolve, reject) => {
      socket.emit(
        'lockstep:join',
        { roomId: matchId, reconnectToken: token },
        (response: unknown) => {
          if (response && typeof response === 'object' && 'seed' in response) {
            resolve(response as LockstepStartPacket);
          } else reject(new Error('reconnect rejected'));
        },
      );
    });

    expect(rejoined.yourSlot).toBe(slot);
  });

  it('rate-limits intent flooding', async () => {
    const a = await client();
    const b = await client();

    let relayed = 0;
    b.socket.on('lockstep:turn', (turn: Turn) => {
      relayed += turn.intents.length;
    });

    // A relay cannot reject an intent as illegal, so capping the rate is its
    // only defence against a client flooding every peer's simulation.
    for (let i = 0; i < 200; i++) {
      a.send({ type: IntentType.Attack, target: TILE_OWNER_NONE, ratio: 0.1 });
    }
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(relayed).toBeGreaterThan(0);
    expect(relayed).toBeLessThan(200);
  });

  it('keeps the full input log as a replay', async () => {
    const a = await client();
    a.send({ type: IntentType.Spawn, tile: findFreeLand(a.game, 0) });
    await until(() => a.game.player(a.start.yourSlot)!.hasSpawned);

    const match = harness.router.getMatch(a.start.matchId)!;
    const history = match.replayHistory();

    // Catch-up history and replay are the same artefact, obtained for free.
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.intents[0]!.type).toBe(IntentType.Spawn);
  });
});

/** First unowned land tile, skipping `skip` candidates. */
function findFreeLand(game: TileGame, skip: number): number {
  let seen = 0;
  for (let ref = 0; ref < game.map.tileCount; ref++) {
    if (!game.map.isLand(ref)) continue;
    if (game.map.ownerOf(ref) !== TILE_OWNER_NONE) continue;
    if (seen++ < skip) continue;
    return ref;
  }
  throw new Error('no free land');
}
