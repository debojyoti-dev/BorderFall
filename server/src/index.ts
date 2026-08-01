import { createServer } from 'node:http';
import { env } from './config/env.js';
import { createApp } from './network/http/createApp.js';
import { LockstepRouter } from './network/LockstepRouter.js';
import { MatchRouter } from './network/MatchRouter.js';
import { SocketGateway } from './network/SocketGateway.js';
import { MatchManager } from './match/MatchManager.js';
import { createLogger, errorFields } from './utils/logger.js';

const log = createLogger('boot');
const startedAt = Date.now();

/**
 * Process entry point.
 *
 * Responsibilities, in order: wire the HTTP app to the Socket.IO gateway on a
 * single port, start listening, and install a shutdown path that drains rather
 * than drops. Everything else is behind a factory so that nothing here is
 * needed to test the game.
 */

/**
 * Flipped false on the first shutdown signal so `/ready` starts returning 503
 * and the load balancer stops routing new players here, while matches already
 * in progress keep running until the drain deadline.
 */
let accepting = true;

const matches = new MatchManager();

const app = createApp({
  isReady: () => accepting,
  startedAt,
  matches,
});

// One HTTP server for both REST and WebSocket. Socket.IO upgrades in place, so
// a single exposed port keeps ingress and firewall configuration trivial.
const httpServer = createServer(app);
const gateway = new SocketGateway(httpServer);

// The router layers match handling on top of the transport, so rate limiting
// and packet-size guards cannot be bypassed by game code.
const router = new MatchRouter(matches);
router.attach(gateway);

/**
 * The lockstep relay, mounted on its own Socket.IO path.
 *
 * Runs alongside the server-authoritative gateway during the transition to
 * the tile model. Unlike the gateway it holds no world state at all — it
 * stamps intents with the sender's slot and broadcasts turn bundles,
 * and every client derives the world itself.
 */
const lockstep = new LockstepRouter(httpServer);

httpServer.listen(env.port, env.host, () => {
  log.info('BorderFall server listening', {
    host: env.host,
    port: env.port,
    env: env.nodeEnv,
    mongo: env.mongoEnabled,
    redis: env.redisEnabled,
  });
});

/* -------------------------------------------------------------------------- */
/* Graceful shutdown                                                           */
/* -------------------------------------------------------------------------- */

/** Hard deadline after which we stop being polite and exit anyway. */
const DRAIN_TIMEOUT_MS = 15_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  accepting = false;

  log.info('Shutting down', { signal, drainTimeoutMs: DRAIN_TIMEOUT_MS });

  // Exit regardless if a socket or a match refuses to settle. An orchestrator
  // will SIGKILL us shortly anyway; exiting on our own terms lets the logs
  // record why.
  const forceExit = setTimeout(() => {
    log.warn('Drain timed out; forcing exit');
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Stop broadcasting and tear matches down before closing sockets, so no
    // timer fires against a half-closed server during the drain.
    router.dispose();
    matches.disposeAll();
    await lockstep.close();

    await gateway.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    log.info('Shutdown complete', { uptimeMs: Date.now() - startedAt });
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    log.error('Error during shutdown', errorFields(error));
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An unhandled rejection means some async path failed in a way nobody handled.
 * Logged loudly but *not* fatal: killing a process hosting several live matches
 * over one stray promise trades a localised bug for a total outage.
 */
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', errorFields(reason));
});

/**
 * An uncaught exception, by contrast, leaves the process in an unknown state.
 * Log it and exit so the orchestrator restarts us clean.
 */
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception; exiting', errorFields(error));
  void shutdown('uncaughtException');
});
