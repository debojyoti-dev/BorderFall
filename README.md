# BorderFall

A browser-based massively multiplayer real-time strategy game. Hundreds of
players contest a procedurally generated world of 5 000+ territories through
conquest, economy, construction, naval power, nuclear weapons and diplomacy.

The server is authoritative: clients send intentions, the simulation decides
outcomes. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design.

> **Status: Phase 1 of 10 complete.** Monorepo, shared contracts, engine core
> and transport are in place and verified end to end. The renderer and world
> generation land in Phase 2.

---

## Requirements

- Node.js **20.11+**
- npm 10+
- Docker & Docker Compose (optional — only for the containerised stack)

MongoDB and Redis are **optional in development**. With `MONGO_ENABLED=false`
the game runs entirely in memory, which is the fastest way to work on gameplay.

---

## Getting started

```bash
npm install
cp .env.example .env      # defaults work out of the box for development
npm run dev               # server on :3001, client on :5173
```

Open <http://localhost:5173>. The client connects over WebSocket and displays
live round-trip latency, jitter and clock offset against the server.

### Docker

```bash
npm run docker:up         # client on :8080, server on :3001
npm run docker:down
```

---

## Scripts

| Command                 | Description                            |
| ----------------------- | -------------------------------------- |
| `npm run dev`           | Server and client in watch mode        |
| `npm run build`         | Build every package                    |
| `npm test`              | Run the full Vitest suite              |
| `npm run test:watch`    | Vitest in watch mode                   |
| `npm run test:coverage` | Tests with a V8 coverage report        |
| `npm run typecheck`     | `tsc -b` across all project references |
| `npm run lint`          | ESLint                                 |
| `npm run format`        | Prettier, write mode                   |

Scope tests to one package with `npx vitest --project server`.

---

## Layout

```
shared/   Contracts shared by both runtimes — enums, packets, balance, PRNG
server/   Authoritative simulation host — engine, systems, network
client/   Browser client — PixiJS renderer inside a React shell
docker/   Dockerfiles and nginx configuration
```

`@borderfall/shared` is consumed as TypeScript **source**, not as a built
package, so a change to a shared constant hot-reloads straight into the browser.

---

## Health & observability

| Endpoint        | Purpose                          |
| --------------- | -------------------------------- |
| `/health`       | Liveness — process is up         |
| `/ready`        | Readiness — 503 while draining   |
| `/metrics`      | Prometheus exposition format     |
| `/metrics.json` | Same data as JSON, for debugging |
| `/version`      | Protocol version and environment |

---

## Configuration

All variables are documented in [`.env.example`](./.env.example).

`JWT_SECRET` is **required in production** — the server refuses to start without
it rather than falling back to a predictable signing key.

---

## Contributing

`npm run lint`, `npm run typecheck` and `npm test` must pass. A Husky
`pre-commit` hook runs ESLint and Prettier over staged files; CI additionally
builds both Docker images and smoke-tests the server container.

---

## Licence

This is an original implementation. It takes inspiration from the territory-control
genre but contains no third-party game code or assets.
