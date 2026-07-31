# Design notes — what we take from OpenFrontIO, and what we don't

> Reference study, August 2026. The repository was cloned to `reference/`
> (gitignored) and read for **game design**. No code or assets were copied.

## Licence constraint

OpenFrontIO is **AGPL-3.0**, with assets under CC BY-SA 4.0 and a `proprietary/`
directory that is all-rights-reserved. AGPL is the strongest copyleft, and being
_Affero_, its obligations trigger on **network use** — running a public game
server — not merely on distribution.

Copying any of its source into BorderFall would make BorderFall AGPL-3.0. Game
_mechanics, formulas and design ideas_ are not copyrightable; expression is. So
this document records mechanics and reasoning, and everything below is
implemented independently.

`reference/` is in `.gitignore` and must never be committed.

---

## The one architectural idea we deliberately reject

OpenFront runs **deterministic lockstep**: the server only relays intents, and
every client runs the full simulation in a worker thread.

|                    | Lockstep (OpenFront)                          | Server-authoritative (BorderFall)   |
| ------------------ | --------------------------------------------- | ----------------------------------- |
| Server cost        | Near zero — a relay                           | Full simulation per match           |
| Cheat resistance   | Client holds all state                        | Server validates every command      |
| Hidden information | Impossible — every client knows everything    | Natural — server filters per player |
| Determinism burden | Total: any float divergence desyncs the match | Only map generation                 |
| Client CPU         | Runs the whole simulation                     | Renders only                        |

Lockstep is genuinely cheaper to operate and is why they can run large games
inexpensively. We keep server authority anyway, for two reasons:

1. It is the project's stated first principle — clients send intentions, never
   results.
2. Hidden information is a design goal here. Private gold reserves, fog of war
   and radar are all mechanics that lockstep cannot support, because every
   client necessarily holds the entire game state.

Our measured cost at 200 players / 5 000 territories is 0.01 ms per 50 ms tick,
so server-side simulation is not the bottleneck their design was avoiding.

---

## Mechanics worth adopting

### 1. Sublinear troop capacity — the anti-snowball lever

Their cap is roughly `tiles^0.6 · 1000 + cities · bonus`. The **exponent below
1** is the important part: doubling your territory raises your army ceiling by
only ~1.5×, so conquest has diminishing military returns and a smaller player
is never mathematically hopeless.

Our logistic growth already does this _per territory_, but empire-wide capacity
is still linear in territory count. Adopting a sublinear global cap is a small
change with a large effect on match shape.

### 2. Attack speed from force ratio **and** border width

Their advance rate is `clamp(5·attackTroops / defenderTroops, 0.01, 0.5) ·
adjacentTiles · 3`.

Two ideas here:

- Speed depends on the ratio to the defender's **whole** army, not the local
  garrison — so a defender under pressure elsewhere genuinely weakens.
- Speed scales with **shared border width**. Wide fronts advance faster than
  narrow ones. This makes the _shape_ of a border a real strategic object:
  chokepoints work, salients are dangerous, encirclement pays.

We have the neighbour graph already, so counting shared border is nearly free.

### 3. Spawn phase

A timed placement window before the match starts, with a minimum distance
between players and a period of spawn immunity. Prevents the "eliminated in the
first ten seconds by a neighbour" outcome that makes a match feel arbitrary.

### 4. Expiring alliances

Alliances have a **duration** and must be actively renewed. Permanent alliances
produce permanent stalemate blocs; expiry keeps diplomacy live and makes
betrayal a timing decision rather than a binary.

### 5. Trade ships and piracy

Ports generate passive gold by sending trade ships to other ports — including
_neutral and enemy_ ones. Those ships can be raided. This gives the navy an
economic role beyond combat and creates a reason to contest sea lanes, which a
purely military navy never does.

### 6. Defence posts

A structure that grants an area defence bonus and slows enemy advance nearby,
distinct from a fort's flat per-territory bonus. Turns defence into something
with a _radius_ and therefore a placement decision.

### 7. SAM launchers as active interceptors

Rather than our passive `interceptChance` on an anti-air building, an
interceptor with range, cooldown and a real missile that has to reach the
target. Makes nuclear exchange a two-sided engagement rather than a dice roll.

### 8. Fallout

Detonation leaves territory temporarily poisoned — population cannot grow there
for a period. Adds a genuine cost to nuking land you intend to take.

### 9. Quick chat and emoji instead of free text

Bounded, structured communication: a menu of phrases plus emoji. No moderation
burden, no toxicity vector, and it works across languages without translation.
For a game whose diplomacy is the point, this is strictly better than a text box.

### 10. Doomsday clock

An escalating global timer that forces an endgame, so a stalemate between two
large blocs resolves instead of running forever.

### 11. Embargo

Refuse trade with a specific player. Economic warfare as a diplomatic tool
short of declaring war.

### 12. Named AI nations rather than "Bot 4"

Bots spawn as named factions with personality. Costs nothing and makes the world
feel populated rather than filled with placeholders.

---

## What we keep that they don't have

- **Voronoi territories** rather than per-pixel tiles. Discrete, clickable
  regions with individual garrisons, terrain and buildings — more tactical
  depth per unit of screen area, and it is what gives BorderFall its own feel.
- **Per-territory garrisons.** Their troops are one global pool; ours are
  positional, so defending the right place matters.
- **Hidden information** — private resources, and radar/fog to come.
- **Deterministic seed-based map replication** — 4 bytes instead of a downloaded
  map binary.

---

## Revised plan

| Phase | Scope                                                      | Enhancement from this study |
| ----- | ---------------------------------------------------------- | --------------------------- |
| 4a    | Sublinear troop cap; border-width attack speed             | Ideas 1, 2                  |
| 4b    | Spawn phase with immunity                                  | Idea 3                      |
| 5     | Buildings + defence posts + SAM sites                      | Ideas 6, 7                  |
| 6     | Ships, naval combat, **trade ships and piracy**            | Idea 5                      |
| 7     | Missiles, active SAM interception, **fallout**             | Ideas 7, 8                  |
| 8     | **Expiring** alliances, trade, **embargo**, **quick chat** | Ideas 4, 9, 11              |
| 9     | **Named AI nations**, matchmaking, spectator, replay       | Idea 12                     |
| 10    | Optimisation, balancing, hardening, **doomsday clock**     | Idea 10                     |
