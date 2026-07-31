import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { isValidPlayerName, sanitisePlayerName } from '@borderfall/shared';
import { env } from '../config/env.js';

/**
 * Identity issuance and verification.
 *
 * Guest play is a first-class path, not a fallback: requiring registration
 * before a player can see the game is the single biggest drop-off point for a
 * browser title. A guest receives a real signed token with a real account id,
 * so every downstream system treats them identically to a registered user — the
 * only difference is that the id is not backed by a persisted record.
 */

export interface TokenClaims {
  /** Stable account identity. */
  sub: string;
  name: string;
  guest: boolean;
}

export interface AuthenticatedIdentity {
  readonly accountId: string;
  readonly name: string;
  readonly isGuest: boolean;
}

export function issueGuestToken(requestedName: string): {
  token: string;
  identity: AuthenticatedIdentity;
} {
  const sanitised = sanitisePlayerName(requestedName);
  const name = isValidPlayerName(sanitised)
    ? sanitised
    : `Player${Math.floor(Math.random() * 9000) + 1000}`;

  const identity: AuthenticatedIdentity = {
    // Prefixed so guest ids are never mistaken for a registered account id,
    // which matters once persistence lands and one of the two is a real key.
    accountId: `guest:${randomUUID()}`,
    name,
    isGuest: true,
  };

  return { token: signIdentity(identity), identity };
}

export function signIdentity(identity: AuthenticatedIdentity): string {
  const claims: TokenClaims = {
    sub: identity.accountId,
    name: identity.name,
    guest: identity.isGuest,
  };
  // `expiresIn` accepts a duration string ("7d") or seconds. It comes from the
  // environment as a string, so the cast asserts the shape the library expects;
  // NonNullable is required because `exactOptionalPropertyTypes` would
  // otherwise widen the property to include `undefined`.
  const expiresIn = env.jwtExpiresIn as NonNullable<jwt.SignOptions['expiresIn']>;
  return jwt.sign(claims, env.jwtSecret, { expiresIn });
}

/**
 * Verifies a token, returning `null` on any failure.
 *
 * Deliberately returns null rather than throwing or distinguishing failure
 * modes. A caller that could tell "expired" from "bad signature" from
 * "malformed" would be tempted to report that difference to the client, which
 * is an oracle for forging attempts.
 */
export function verifyToken(token: string): AuthenticatedIdentity | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) return null;

    const claims = decoded as Partial<TokenClaims>;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
    if (typeof claims.name !== 'string') return null;

    return {
      accountId: claims.sub,
      name: sanitisePlayerName(claims.name),
      isGuest: claims.guest === true,
    };
  } catch {
    return null;
  }
}
