import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { PROTOCOL_VERSION } from '@borderfall/shared';
import { env } from '../../config/env.js';
import { createLogger, errorFields } from '../../utils/logger.js';
import { Metric, metrics } from '../../services/metrics.js';
import type { MatchManager } from '../../match/MatchManager.js';
import { createRoutes } from './routes.js';

const log = createLogger('http');

export interface AppDependencies {
  /** Reports whether the process is ready to accept traffic. */
  isReady: () => boolean;
  /** Process start time, for uptime reporting. */
  startedAt: number;
  /** Match registry backing the lobby endpoints. */
  matches: MatchManager;
}

/**
 * Builds the Express application.
 *
 * Constructed via a factory rather than exported as a module singleton so that
 * integration tests can spin up an isolated app with stubbed dependencies, and
 * so a future multi-tenant deployment can host more than one.
 *
 * The HTTP surface is deliberately thin: gameplay runs entirely over Socket.IO.
 * Express handles health, metrics, auth and replay retrieval — things that are
 * request/response shaped and benefit from ordinary HTTP caching and tooling.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Behind a load balancer, `req.ip` must reflect X-Forwarded-For for the rate
  // limiter to key on the real client rather than on the proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The client is served from a separate origin (nginx/Vite), so the
      // default same-origin resource policy would block it.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // `true` selects helmet's default policy. Disabled in development
      // because Vite's HMR client injects inline scripts that a strict CSP
      // blocks, which would break hot reload for no security benefit locally.
      contentSecurityPolicy: env.isProduction,
    }),
  );

  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST'],
    }),
  );

  app.use(express.json({ limit: '64kb' }));

  /* ---------------------------------------------------------------------- */
  /* Health                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Liveness: is the process alive at all?
   *
   * Deliberately checks nothing beyond "the event loop is turning". An
   * orchestrator restarts the container when this fails, so making it depend on
   * a database would turn a transient Mongo blip into a restart loop that drops
   * every in-progress match.
   */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptimeMs: Date.now() - deps.startedAt,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  /**
   * Readiness: should this instance receive new traffic?
   *
   * Unlike liveness, this *does* go unready during shutdown so the load
   * balancer stops sending new players while existing matches drain.
   */
  app.get('/ready', (_req: Request, res: Response) => {
    const ready = deps.isReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'draining',
      matches: metrics.getGauge(Metric.matchesActive),
      players: metrics.getGauge(Metric.playersActive),
    });
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    if (!env.metricsEnabled) {
      res.status(404).end();
      return;
    }
    res.type('text/plain; version=0.0.4').send(metrics.toPrometheus());
  });

  app.get('/metrics.json', (_req: Request, res: Response) => {
    if (!env.metricsEnabled) {
      res.status(404).end();
      return;
    }
    res.json(metrics.toJSON());
  });

  app.get('/version', (_req: Request, res: Response) => {
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      nodeEnv: env.nodeEnv,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Application routes                                                      */
  /* ---------------------------------------------------------------------- */

  app.use(createRoutes(deps.matches));

  /* ---------------------------------------------------------------------- */
  /* Fallbacks                                                               */
  /* ---------------------------------------------------------------------- */

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Express identifies an error handler by its four-parameter arity, so `next`
  // must stay in the signature even though it is unused.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled HTTP error', errorFields(error));
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
