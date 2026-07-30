import { env } from '../config/env.js';

/**
 * Minimal structured logger.
 *
 * Written by hand rather than pulled in from Pino/Winston for one reason: the
 * simulation loop logs from inside the tick, and the level check has to be a
 * single integer comparison with zero allocation when the level is disabled.
 * A `logger.debug(...)` call on a hot path must cost essentially nothing in
 * production, and that is easier to guarantee with 60 lines we control than
 * with a general-purpose logging framework.
 *
 * Output is JSON in production (for log shipping) and human-readable in
 * development.
 */

export const LogLevel = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
} as const;

export type LogLevelName = keyof typeof LogLevel;

function resolveLevel(name: string): number {
  return LogLevel[name as LogLevelName] ?? LogLevel.info;
}

const activeLevel = resolveLevel(env.logLevel);

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Built from the code point so no raw control bytes sit in the source file. */
const ESC = String.fromCharCode(27);
const LEVEL_COLORS: Record<string, string> = {
  debug: ESC + '[90m',
  info: ESC + '[36m',
  warn: ESC + '[33m',
  error: ESC + '[31m',
};
const RESET = ESC + '[0m';

function write(level: LogLevelName, scope: string, message: string, fields?: LogFields): void {
  if (LogLevel[level] < activeLevel) return;

  if (env.logJson) {
    process.stdout.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level,
        scope,
        message,
        ...fields,
      })}\n`,
    );
    return;
  }

  const color = LEVEL_COLORS[level] ?? '';
  const stamp = new Date().toISOString().slice(11, 23);
  let line = `${color}${stamp} ${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${message}`;
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) line += ` ${key}=${String(value)}`;
    }
  }
  process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derives a child logger with a nested scope, e.g. `match:abc123`. */
  child(scope: string): Logger;
  /** True when the level would actually emit — guard expensive field building. */
  isEnabled(level: LogLevelName): boolean;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => write('debug', scope, message, fields),
    info: (message, fields) => write('info', scope, message, fields),
    warn: (message, fields) => write('warn', scope, message, fields),
    error: (message, fields) => write('error', scope, message, fields),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
    isEnabled: (level) => LogLevel[level] >= activeLevel,
  };
}

export const logger = createLogger('borderfall');

/** Normalises a caught `unknown` into loggable fields. */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack ?? null };
  }
  return { error: String(error) };
}
