# BorderFall — Architecture

> Living document. Updated whenever a system is added or a contract changes.
> **Last updated:** Phase 4 complete.

BorderFall is a browser-based massively multiplayer real-time strategy game:
hundreds of concurrent players contesting a procedurally generated world of
5 000+ territories through conquest, economy, construction, naval power,
nuclear weapons and diplomacy.

---

## 1. Phase status

| Phase | Scope                                           | Status         |
| ----- | ----------------------------------------------- | -------------- |
| 1     | Monorepo, shared contracts, engine core, DevOps | ✅ Complete    |
| 2     | PixiJS renderer, camera, world generation       | ✅ Complete    |
| 3     | Socket.IO rooms, state synchronisation          | ✅ Complete    |
| 4     | Territory capture, population, economy          | ✅ Complete    |
| 5     | Buildings                                       | ⬜ Not started |
| 6     | Ships and naval combat                          | ⬜ Not started |
| 7     | Missiles and anti-air                           | ⬜ Not started |
| 8     | Alliances, trade, chat, leaderboard             | ⬜ Not started |
| 9     | Bots, matchmaking, spectator, replay            | ⬜ Not started |
| 10    | Optimisation, balancing, hardening, deploy      | ⬜ Not started |

---

## 2. The one rule

**The server is authoritative. Clients send intentions, never results.**

```
Player clicks territory
        ↓
Client emits  cmd:attack { from, to, ratio, seq }      ← an intention
        ↓
Server validates  (ownership, adjacency, troops, cooldown, rate limit)
        ↓
Simulation resolves combat on its own tick
        ↓
Server mutates authoritative state
        ↓
Server broadcasts  world:delta                          ← the result
        ↓
Client renders what it is told
```

The client holds no authority over combat, ownership, economy, buildings,
missiles, population or resources. Every inbound packet is treated as hostile
until validated. A client that reports "I now own territory 42" is ignored; the
only thing it may say is "I would like to attack territory 42".

**Corollary — commands carry ratios, not absolutes.** A client's view of a
garrison is always tens to hundreds of milliseconds stale, so an absolute troop
count would routinely be wrong on arrival. `ratio: 0.6` is always meaningful and
eliminates a whole class of latency-induced rejections.

---

## 3. Stack

| Layer     | Technology                                                            |
| --------- | --------------------------------------------------------------------- |
| Client    | React 19, TypeScript, Vite 6, PixiJS 8, Zustand 5, Tailwind 4         |
| Transport | Socket.IO 4 (WebSocket only)                                          |
| Server    | Node 20, Express 4, TypeScript, Socket.IO 4                           |
| Storage   | MongoDB (persistence only), Redis (optional, multi-node coordination) |
| Tooling   | Docker, ESLint 9, Prettier, Husky, GitHub Actions, Vitest, Playwright |

---

## 4. Repository layout

```
borderfall/
├── shared/          Contracts shared by both runtimes. No dependencies.
│   └── src/
│       ├── enums/         Wire-stable enumerations (append-only)
│       ├── constants/     Engine timing, balance tables, palettes
│       ├── interfaces/    Entity views, world geometry, data specs
│       ├── packets/       Client→server commands, server→client updates
│       ├── events/        Typed Socket.IO event maps
│       └── utils/         PRNG, math, rate limiting, validation, ids
│
├── server/          Authoritative simulation host.
│   └── src/
│       ├── engine/        EventBus, TickScheduler, System contract
│       ├── systems/       One directory per simulation system  (Phase 4+)
│       ├── network/       Socket gateway, HTTP app
│       ├── matchmaking/   Room registry and queues            (Phase 9)
│       ├── database/      Mongo models and repositories       (Phase 9)
│       ├── services/      Metrics, auth, replay recording
│       ├── utils/         Logger
│       └── config/        Environment parsing
│
├── client/          Browser client.
│   └── src/
│       ├── game/          Renderer, camera, input             (Phase 2)
│       ├── socket/        SocketClient (connection + clock sync)
│       ├── store/         Zustand stores (UI-facing state only)
│       ├── components/    React HUD
│       └── test/          jsdom setup
│
├── docker/          Dockerfiles and nginx config
└── docs/            API and protocol documentation
```

### Why `shared/` ships TypeScript source

`@borderfall/shared` exports `./src/index.ts` rather than a built `dist/`.
The server transpiles it through `tsx` in development and inlines it via tsup
(`noExternal`) for production; the client aliases it in `vite.config.ts`. This
removes the build-order dance entirely and gives cross-package hot reload — a
balance constant edit is live in the browser immediately.

`shared/` has three hard rules, enforced by ESLint:

1. No runtime dependencies (no Express, Pixi, React, Mongoose).
2. No environment assumptions (no `window`, no `process`, no `fs`).
3. No mutable module state — one Node process hosts many matches.

---

## 5. Data model: the static/dynamic split

This is the most consequential decision in the project.

**Static** — polygons, centroids, terrain, the neighbour graph. Fixed for a
match's lifetime, generated deterministically from a 32-bit seed.
**Never transmitted.** The server sends the seed; every client runs the same
generator and reconstructs an identical world. A 5 000-territory map costs
**4 bytes** on the wire instead of roughly **2 MB** of vertex data.

**Dynamic** — owner, population, troops, buildings. Changes constantly, so this
is the _only_ thing that crosses the network, and it is small enough to
delta-encode at 20 Hz for 200 players.

Both halves are stored as **structure-of-arrays** (parallel typed arrays) rather
than arrays of objects:

```ts
owner: Uint16Array; // OWNER_NONE (0xFFFF) = neutral
population: Uint32Array;
troops: Uint32Array;
terrain: Uint8Array;
```

At 5 000 territories, an array-of-objects layout costs a pointer dereference and
a likely cache miss per territory per frame. SoA lets the renderer and the
simulation stream contiguous memory, makes dirty-tracking a bitset, and allows
the whole world to be handed to a Web Worker with zero copying.

Polygons and adjacency use **CSR (compressed sparse row)** layout —
`neighbours[neighbourOffsets[i] .. neighbourOffsets[i+1]]` — so adjacency
queries, which run on every attack validation and every bot decision, are an
allocation-free contiguous scan instead of a `Map` lookup and pointer chase.

---

## 6. Determinism

Three features depend on the simulation being exactly reproducible: seed-based
map sharing, replays that store commands rather than state, and load tests that
run a match at 100× speed.

Determinism is enforced by four rules:

1. **`Rng`, never `Math.random()`.** xoshiro128\*\* seeded via SplitMix32
   (`shared/src/utils/prng.ts`).
2. **Per-system RNG streams.** Each system gets `rng.fork(name)`. Adding a
   combat roll cannot shift the stream the map generator or the bots observe —
   otherwise a balance tweak silently changes terrain and breaks every replay.
3. **Fixed timestep.** Systems receive their declared interval as `deltaMs`,
   never the real frame time.
4. **No wall clock in the simulation.** Systems read `context.elapsedMs`.
   `Date.now()` inside a tick is a bug.

---

## 6a. World generation

Implemented in `shared/src/world/`, so server and client run the identical
pipeline from a single 32-bit seed.

```
seed
 └─ Poisson-disc sampling      blue-noise sites, no clumping
     └─ Lloyd relaxation (×2)   regularises cell shape
         └─ Voronoi clipping    polygons + neighbour graph (CSR)
             └─ Elevation       continent masks + fBm + border falloff
                 └─ Terrain     percentile-derived biome thresholds
                     └─ Coast / lake / landmass labelling
                         └─ Spawn selection (greedy farthest-point)
```

**Why half-plane clipping rather than Delaunay duality.** The textbook approach
triangulates the sites and takes the dual. It is asymptotically better
(O(n log n) vs O(n·k)) but needs exact geometric predicates to stay robust:
with float orientation tests, nearly collinear or cocircular sites produce
inverted triangles, and the failure mode is a _silently corrupt map_ — a
territory with the wrong neighbours, or a self-intersecting polygon — rather
than a crash. Clipping each cell from the bounding box by successive bisector
half-planes is immune to all of it: every intermediate result is convex by
construction, and degenerate input yields a degenerate-but-valid polygon. At
5 000 sites this runs in ~115 ms, once per match.

The neighbour graph falls out for free: site _j_ borders site _i_ exactly when
an edge of _i_'s polygon lies on their perpendicular bisector. That exact test
is used rather than "did this clip change the polygon?", because a clip can trim
a corner that a later clip removes entirely — which would report a border that
does not exist and let a player attack a non-adjacent territory.

**Thresholds are derived from distributions, not hard-coded.** Sea level is the
`(1 − landRatio)` percentile of the elevation field; mountain, hill and moisture
cutoffs are percentiles of their own fields. Absolute cutoffs against noise that
concentrates near its midpoint produced 0 % mountains and 0.1 % desert — a map
of undifferentiated plains. Percentiles guarantee the requested proportions on
every seed.

Measured at 5 000 territories: ~115 ms generation, mean neighbour degree 5.89
(planar Voronoi theory predicts 6), 466 KB of geometry in memory, **4 bytes on
the wire**.

---

## 6b. Client rendering

**Chunked geometry with dirty rebuild.** The world is divided into a 16×16 grid;
each chunk owns one Pixi `Graphics` batching the ~20 polygons whose centroids
fall inside it.

The two obvious alternatives both fail at 5 000 territories: one `Graphics` per
territory means 5 000 scene-graph nodes to transform and cull every frame; a
single `Graphics` for the whole map means one territory changing owner
re-tessellates all 5 000 polygons. Chunking makes a capture cost one chunk
rebuild, culling a single `visible` flag, and the scene graph ~256 nodes.

Off-screen dirty chunks are deliberately _left_ dirty and rebuilt when they
scroll into view, which spreads a large state change across frames instead of
spiking on one.

Hover and selection outlines live in a separate `Graphics` from the chunks.
Folding them in would dirty — and re-tessellate — a 20-polygon chunk on every
pointer move.

Panning and zooming apply a single transform to the parent container rather than
repositioning children, so camera movement is effectively free.

**Picking is nearest-centroid, not point-in-polygon.** For a Voronoi diagram
those are the same answer by definition, so a spatial-grid nearest-site query
answers in O(1) expected time where polygon testing would be O(n) per mouse
move.

**Camera inertia integrates analytically.** Velocity decays as `v₀·fᵗ`, so
displacement over a frame is `v₀·(f^dt − 1)/ln f`. Using `v * dt` Euler steps
makes coasting distance frame-rate dependent even when the decay is not — one
1 s frame coasted ~600 world units where ten 100 ms frames coasted ~113.

---

## 6c. Match hosting

One process hosts many matches. `MatchInstance` owns everything for one game —
world, players, event bus, tick loop — with no module-level state, which is what
makes that possible and what lets a test construct a match, drive it with
synthetic time, and assert on it without a socket in sight.

```
MatchManager          registry, quick-play matchmaking, reaping
  └─ MatchInstance    world + players + scheduler + bus
       ├─ WorldState  authoritative SoA + dirty tracking
       └─ PlayerRegistry
MatchRouter           socket → match, command validation
  └─ StateBroadcaster snapshots, deltas, resources, standings
```

**Quick play joins the fullest room with space, not the emptiest.** Spreading
players thinly across half-empty rooms is what makes a session-based game feel
dead at low population.

**Slots are never recycled.** A slot freed by a departing player and reissued
would be applied by any delta still in flight to the _new_ occupant, briefly
painting territories the wrong colour. Two bytes per slot is far cheaper than
reasoning about that race.

**A disconnect does not forfeit territory.** Players keep their empire for a
90-second grace period; dropping it on a network blip would make a hiccup
unrecoverable and reward opponents for nothing. A reconnect token reclaims the
slot.

---

## 6d. State replication

Every mutation goes through a `WorldState` setter that records the territory
_and_ the specific field that changed. Extraction is therefore O(changed), not
O(world) — which matters when the question "what changed?" is asked 20 times a
second.

| Packet               | Rate    | Contents                                        |
| -------------------- | ------- | ----------------------------------------------- |
| `match:init`         | on join | Map **seed**, roster, reconnect token, snapshot |
| `world:delta`        | 20 Hz   | Changed territories only, as typed arrays       |
| `world:snapshot`     | 10 s    | Keyframe, for gap recovery                      |
| `player:resources`   | 20 Hz   | **Unicast** — gold and food are private         |
| `leaderboard:update` | 2 s     | Public standings                                |

A delta carries `ids`, a `fields` bitmask, and parallel value arrays. Typed
arrays cannot be sparse, so every value slot is populated; entries whose bit is
unset hold stale data the client must ignore.

`encodeDelta` returns `null` when nothing changed, so an idle match sends no
traffic at all rather than 20 empty packets a second per player.

Standings run on a separate 2-second timer because recomputing them is
O(players × territories) — doing that at broadcast rate would dominate the CPU
budget for something a human reads a few times a minute.

### The Socket.IO binary trap

**Socket.IO does not preserve typed-array views.** A `Uint16Array` sent by the
server arrives as a `Buffer` in Node and an `ArrayBuffer` in the browser:

```
server: new Uint16Array([1, 2, 3])   // 3 elements
client: <Buffer 01 00 02 00 03 00>   // .length === 6
        received[0] === 1            // correct by coincidence
        received[1] === 0            // silently wrong — should be 2
```

Index 0 reads correctly for small little-endian values, so a naive check passes
against entirely broken data while every loop over `.length` runs twice too
long. **Every received binary packet must go through `decodeDelta` /
`decodeSnapshot`** (`shared/src/packets/decode.ts`), which copies rather than
wraps — Node `Buffer`s come from a shared pool, so their `byteOffset` is
routinely misaligned and wrapping would throw intermittently.

---

## 6e. Command pipeline

```
authenticate (at connect)  →  rate-limit  →  validate  →  mutate  →  acknowledge
```

Identity is resolved once from the handshake token, never per command: a handler
that re-read a client-supplied identity would trust the client with the most
security-critical value in the system.

Rate limiting runs _before_ validation — the limiter exists to make a flood
cheap to reject, which it cannot do if validation runs first.

Validation is ordered cheapest-first: type checks, then bounds, then state
lookups, then the graph query. Adjacency is always re-derived from the neighbour
graph; without that check a modified client could strike anywhere on the map.

Rejections return a numeric `RejectReason`, never prose — allocation-free on the
hot path, and no opportunity to leak an opponent's troop count through an error
string.

---

## 6f. The simulation

Four systems, each owning one slice of state and communicating only through the
bus.

### Population — logistic, not linear

```
Δpop = rate · pop · (1 − pop / capacity)
```

Linear growth makes wide empires unbeatable: every territory adds the same
absolute output forever, so the leader's advantage compounds without limit and
the match is decided in the first two minutes. The logistic curve is fast when a
territory is underpopulated and stalls as it fills, which gives a small player a
genuine catch-up window and forces a large one to _invest_ in cities to raise
`capacity` rather than merely holding more dirt.

A flat growth **floor** matters more than it looks: the logistic term is
proportional to current population, so a territory at zero could never recover
and conquered land would stay permanently dead.

Troops accrue from population automatically, capped as a fraction of it. Manual
per-territory mobilisation across hundreds of tiles is data entry, not strategy.

### Economy — two resources on purpose

Gold is the **spending** currency (buildings, ships, missiles); food is the
**sustaining** one, consumed by armies every tick. Splitting them gives an army
an ongoing cost rather than only a purchase price, so stockpiling troops is a
decision with a downside. A single currency collapses that into "save up and
win". Running out of food disbands troops at 5 %/s, which makes over-extension
self-correcting instead of free.

The sweep is one pass over territories accumulating into per-slot buckets —
O(territories), not O(players × territories), which at 200 × 5 000 would be a
million operations per second.

### Combat — transit and Lanchester attrition

Attacks are no longer instant. An army leaves immediately, spends
`traversalCost × 900 ms` in transit, then fights over multiple 100 ms ticks.

Transit time is what turns the map into a real space: reinforcing a threatened
tile becomes possible, mountains become genuinely hard to cross, and an attack
becomes a decision rather than a click. Phase 3's instant resolution made
position meaningless.

Attrition follows **Lanchester's square law** — each side loses troops in
proportion to the _opposing_ force — so combat power scales with the square of
numbers. That single choice produces the central strategic lever of the genre:
concentrating force beats spreading it. Under a linear law, two 50-troop attacks
equal one of 100 and there is never a reason to mass an army.

An army arriving at a target that turned friendly mid-flight reinforces instead
of attacking, because territories change hands while armies are in transit.

### Victory

A player is eliminated when they hold no territory **and** have no army in
flight. Checking territory alone would eliminate someone in the one-tick window
between committing their last garrison and that attack landing.

### Measured at target scale

200 players, 5 000 territories, 60 s of simulation:

| Metric          | Value                       |
| --------------- | --------------------------- |
| Wall time       | 12 ms (**5 048× realtime**) |
| Per master tick | 0.01 ms (budget 50 ms)      |
| Slowest system  | victory, 0.93 ms peak       |

---

## 7. Engine core

### Tick scheduler

One master loop at **50 ms** drives every system from its own fixed accumulator.

| System      | Interval | Order |
| ----------- | -------- | ----- |
| Population  | 1000 ms  | 100   |
| Economy     | 1000 ms  | 200   |
| Buildings   | 250 ms   | 300   |
| Combat      | 100 ms   | 400   |
| Ships       | 100 ms   | 500   |
| Missiles    | 50 ms    | 600   |
| Diplomacy   | 1000 ms  | 700   |
| Bots        | 500 ms   | 800   |
| Leaderboard | 2000 ms  | 900   |
| Victory     | 2000 ms  | 1000  |

Every interval must be an integer multiple of the master tick; the scheduler
throws at registration otherwise.

**Why not one `setInterval` per system?** Node timers have no ordering guarantee
between them. With ten independent intervals, whether "economy produces income"
runs before "buildings spend it" varies tick to tick, and the simulation stops
being reproducible. One timer with per-system accumulators gives exact
intervals, deterministic within-tick ordering by `order`, and the ability to run
with no clock at all.

**Catch-up is clamped** at `MAX_CATCHUP_MS` (500 ms). After a GC pause or a
suspended VM the accumulator can hold seconds of unsimulated time; replaying it
all takes longer than the stall itself and builds more backlog — the classic
spiral of death. Excess time is dropped and reported.

### Event bus

Systems never import one another. They emit typed events; the bus dispatches.
`CombatSystem` needs to inform the leaderboard, the replay recorder, the stats
tracker and the bot controller — and imports none of them.

**Dispatch is deferred.** `emit()` queues; the loop `flush()`es once per tick.
Immediate dispatch would let a handler mutate the world while the emitting
system is still iterating it — and because the "collection" is a set of parallel
typed arrays with no iterator to invalidate loudly, that produces a silently
wrong simulation rather than a crash.

Implementation detail that matters: `emit` always appends to the _collect_
buffer, while `flush` dispatches from a parked _batch_ array. The two are always
distinct, so a re-emitting handler cannot extend the array its own dispatch loop
is walking. Cascades are bounded at 8 passes.

Handler exceptions are caught and logged — a bug in the leaderboard must not
take down a match holding 200 players.

### System contract

```ts
interface ISimulationSystem {
  readonly name: string;
  readonly intervalMs: number;
  readonly order: number;
  init?(context: SystemContext): void;
  update(context: SystemContext, deltaMs: number): void;
  dispose?(): void;
}
```

Context is injected, never imported — that is what makes systems unit-testable
without a server, and lets one process host several independent matches.

---

## 8. Networking

### Transport

WebSocket only; no long-polling fallback. A silent downgrade to a transport with
200 ms+ effective latency is worse for an RTS than a visible connection failure
the player can act on. `perMessageDeflate` is off — deltas are small and
frequent, so compression costs more CPU than it saves.

### Two-tier state replication

- **`match:init`** — once on join. Carries the map _seed_, the player roster and
  a full baseline snapshot.
- **`world:delta`** — 20 Hz. Changed territories only: an id array, a
  `TerritoryField` bitmask array, and parallel value arrays. In steady state
  under 2 % of territories change per tick, making a delta roughly two orders of
  magnitude smaller than a snapshot.
- **`world:snapshot`** — every 10 s as a keyframe, so a client that missed a
  delta resynchronises without rejoining.

The client renders two network ticks (100 ms) behind the newest snapshot so it
always has two states to interpolate between, absorbing one dropped or reordered
packet without visible stutter.

### Discrete events vs. state deltas

Deltas say _what is true now_; `event:*` packets say _what just happened_.
Transient feedback — a capture flash, a mushroom cloud, a kill-feed line —
cannot be derived from deltas alone, because a territory changing hands twice
between two 20 Hz frames would collapse into a single visible change.

### Clock synchronisation

Every server timestamp is on the server's clock. `SocketClient` probes latency
every 2 s, derives the offset assuming symmetric legs, takes a **median** across
12 samples (a single 800 ms GC outlier would drag a mean far enough to visibly
shift interpolation) and smooths the offset heavily.

### Rate limiting

Token buckets, three per connection — gameplay, chat, diplomacy — so chat spam
cannot starve a player's ability to issue attack orders. The implementation
lives in `shared/` because the server _enforces_ the limit and the client
_predicts_ it to grey out a control before the command is wasted; one
implementation means the two can never disagree.

---

## 9. Client architecture

**The critical split:** world state does **not** live in React.

At 20 Hz across thousands of territories, routing world state through a Zustand
store would trigger a React reconciliation pass per network tick and destroy the
60 fps budget. Instead:

- World state is written directly into **typed arrays** that the PixiJS renderer
  reads each frame. React never sees it.
- Only **derived summaries a human reads** — selected territory, resource
  totals, leaderboard rows — are mirrored into Zustand.

Territories are rendered with Pixi `Graphics`/`Mesh` in a `Container`, never as
React components. Redraws are driven by a dirty set, not by re-rendering the
world each frame.

The `SocketClient` is a module-level singleton created outside React: a
re-render, a Strict-Mode double mount or a route change must never tear down a
live game connection.

---

## 10. Security

| Vector                 | Control                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Forged results         | Server-authoritative simulation; commands are intentions only  |
| Malformed packets      | Every field range-checked before use; `MAX_PACKET_BYTES` cap   |
| Command flooding       | Per-connection token buckets, separate per domain              |
| Name impersonation     | Bidi-override and zero-width code points stripped              |
| Log/terminal injection | C0/C1 control codes stripped from all user text                |
| Credential forgery     | `JWT_SECRET` required in production; server refuses to boot    |
| CORS abuse             | Explicit origin allow-list; wildcards rejected in production   |
| Information leak       | Rejections return numeric codes, never state-revealing prose   |
| Container escape       | Runtime image runs as unprivileged `node`, no compiler present |

Reject reasons are numeric (`RejectReason`) so the rejection path stays
allocation-free on the hot server path and cannot leak an opponent's exact troop
count through error text.

---

## 11. Observability

- `GET /health` — liveness. Deliberately checks nothing external: making it
  depend on Mongo would turn a transient database blip into a restart loop that
  drops every in-progress match.
- `GET /ready` — readiness. Goes 503 during drain so the load balancer stops
  routing new players while existing matches finish.
- `GET /metrics` — Prometheus text; `GET /metrics.json` for debugging.

Histograms use a fixed-size ring buffer — written every tick for the process
lifetime, an unbounded sample array would be a slow leak that only manifests on
long-lived production servers.

Shutdown drains: stop accepting, close sockets, close HTTP, with a 15 s hard
deadline. `unhandledRejection` is logged but **not** fatal (killing a process
hosting live matches over one stray promise trades a local bug for an outage);
`uncaughtException` _is_ fatal, because process state is then unknown.

---

## 12. Performance targets

| Target             | Value  |
| ------------------ | ------ |
| Concurrent players | 200+   |
| Territories        | 5 000+ |
| Client frame rate  | 60 fps |
| Latency            | <100ms |

Standing constraints: no O(n²) algorithms over territories or players; no
per-tick allocation on hot paths; adjacency and spatial queries must be
CSR/grid-backed, never nested scans.

---

## 13. Decision log

| #   | Decision                                    | Rationale                                                                    |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Seed-based map replication                  | 4 bytes instead of ~2 MB; makes 5 000 territories viable                     |
| 2   | Structure-of-arrays world state             | Cache locality at 5 000 entities; zero-copy worker transfer                  |
| 3   | Single master tick, per-system accumulators | Deterministic ordering; timer-jitter immunity; clockless replay              |
| 4   | Deferred event dispatch                     | Prevents mutation-during-iteration in SoA storage                            |
| 5   | Per-system forked RNG streams               | A balance tweak in one system cannot perturb another or invalidate replays   |
| 6   | Ratios rather than absolute troop counts    | Removes latency-induced command rejections                                   |
| 7   | World state outside React                   | 20 Hz × 5 000 entities through a store would destroy the frame budget        |
| 8   | `shared/` ships TS source, not `dist/`      | No build-order dependency; cross-package hot reload                          |
| 9   | Numeric reject codes                        | Allocation-free rejection path; no information leak                          |
| 10  | WebSocket-only transport                    | A silent polling downgrade is worse than a visible failure                   |
| 11  | Voronoi by half-plane clipping              | Robust under float arithmetic; Delaunay duality fails _silently_             |
| 12  | Percentile-derived terrain thresholds       | Absolute cutoffs gave 0 % mountains; percentiles hold on every seed          |
| 13  | Chunked renderer with dirty rebuild         | Per-territory nodes or a single mesh both fail at 5 000 polygons             |
| 14  | Nearest-centroid picking                    | Equivalent to point-in-polygon for Voronoi, at O(1) instead of O(n)          |
| 15  | Analytic inertia integration                | Euler stepping makes coast distance frame-rate dependent                     |
| 16  | Field-level dirty tracking in `WorldState`  | Delta extraction is O(changed), not O(5 000), at 20 Hz                       |
| 17  | Explicit binary decode on every packet      | Socket.IO drops typed-array views; raw reads are silently wrong past index 0 |
| 18  | Slots are never recycled                    | An in-flight delta would repaint territories for the wrong player            |
| 19  | Territory retained through reconnect grace  | A network blip must not forfeit an empire                                    |
| 20  | Quick play fills the fullest room           | Thinly-spread rooms make a session game feel dead at low population          |
| 21  | No client-side prediction for capture       | A wrong-colour flicker is worse than the latency it would hide               |
| 22  | Camera focuses the player's spawn on join   | A fit-to-world view of 5 000 cells shows a new player nothing useful         |
| 23  | Logistic population growth                  | Linear growth makes wide empires unbeatable and ends matches in minutes      |
| 24  | Flat growth floor above the logistic term   | Otherwise a territory at zero population can never recover                   |
| 25  | Lanchester square-law attrition             | Makes concentrating force superior — the core strategic lever of the genre   |
| 26  | Armies spend time in transit                | Instant attacks make map position meaningless and deny any counterplay       |
| 27  | Gold and food as separate resources         | Gives an army an ongoing cost, so stockpiling troops has a downside          |
| 28  | Elimination checks armies, not just land    | Prevents elimination in the tick between committing troops and their arrival |
