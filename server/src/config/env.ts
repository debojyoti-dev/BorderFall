import 'dotenv/config';

/**
 * Environment configuration, parsed and validated exactly once at startup.
 *
 * Deliberately fail-fast: a server that boots with a missing `JWT_SECRET` and
 * only discovers it when the first player tries to authenticate is far worse
 * than one that refuses to start. Everything downstream can then treat this
 * object as total and correctly typed.
 */

type NodeEnv = 'development' | 'production' | 'test';

function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function numeric(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be numeric, received "${raw}"`);
  }
  return parsed;
}

function boolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function parseNodeEnv(): NodeEnv {
  const raw = optional('NODE_ENV', 'development');
  if (raw === 'production' || raw === 'test' || raw === 'development') return raw;
  throw new Error(`NODE_ENV must be development, production or test, received "${raw}"`);
}

const nodeEnv = parseNodeEnv();
const isProduction = nodeEnv === 'production';

export const env = {
  nodeEnv,
  isProduction,
  isDevelopment: nodeEnv === 'development',
  isTest: nodeEnv === 'test',

  host: optional('HOST', '0.0.0.0'),
  port: numeric('PORT', 3001),

  /**
   * Comma-separated allow-list. In production an explicit list is mandatory —
   * a wildcard CORS policy on a credentialed Socket.IO endpoint is a real
   * vulnerability, not a convenience.
   */
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** Never defaulted in production; a predictable signing key forges sessions. */
  jwtSecret: isProduction ? required('JWT_SECRET') : optional('JWT_SECRET', 'dev-insecure-secret'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),

  mongoUri: optional('MONGO_URI', 'mongodb://localhost:27017/borderfall'),
  /** Persistence is optional in development so the game runs with no database. */
  mongoEnabled: boolean('MONGO_ENABLED', false),

  redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),
  redisEnabled: boolean('REDIS_ENABLED', false),

  logLevel: optional('LOG_LEVEL', isProduction ? 'info' : 'debug'),
  /** Structured JSON logs in production, human-readable lines in development. */
  logJson: boolean('LOG_JSON', isProduction),

  /** Ceiling on concurrent match instances in this process. */
  maxConcurrentMatches: numeric('MAX_CONCURRENT_MATCHES', 8),
  /** Emits per-tick timing to the metrics endpoint. Small but non-zero cost. */
  metricsEnabled: boolean('METRICS_ENABLED', true),
} as const;

export type Env = typeof env;
