import type { RejectReason } from '../enums/errors.js';

/**
 * Explicit success/failure without exceptions.
 *
 * Command validation runs on the server's hot path, dozens of times per tick.
 * Exceptions there are both slow (stack capture) and easy to swallow by
 * accident. Making failure a value forces every call site to acknowledge the
 * reject reason, which is exactly what we want for a server that must be
 * hostile to malformed input by default.
 */
export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

export interface Failure {
  readonly ok: false;
  readonly reason: RejectReason;
  /** Developer-only detail. Never forwarded to clients. */
  readonly detail?: string;
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(reason: RejectReason, detail?: string): Failure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

export function isOk<T>(result: Result<T>): result is { ok: true; value: T } {
  return result.ok;
}

export function isFail<T>(result: Result<T>): result is Failure {
  return !result.ok;
}

/** Unwraps or throws. Only for tests and startup paths, never in a tick. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`Unwrapped a failed Result (reason ${result.reason}): ${result.detail ?? ''}`);
  }
  return result.value;
}
