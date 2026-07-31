import type { RoomSummary } from '@borderfall/shared';

/**
 * REST client for the lobby and authentication endpoints.
 *
 * Base URL is empty by default so requests go to the same origin and are
 * proxied — by Vite in development and nginx in production. That keeps the
 * browser on one origin, which sidesteps CORS entirely and makes the dev setup
 * match the deployed topology.
 */
const BASE = import.meta.env['VITE_SERVER_URL'] ?? '';

const TOKEN_KEY = 'borderfall.token';

function url(path: string): string {
  // The dev proxy strips a `/api` prefix before forwarding.
  return `${BASE}/api${path}`;
}

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing and some embedded webviews throw on localStorage
    // access. A session without persistence still works; it just cannot
    // resume an identity after a reload.
    return null;
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* Non-fatal — see storedToken. */
  }
}

/**
 * Returns a valid token, reusing a stored one when possible.
 *
 * The stored token is verified against the server rather than trusted locally,
 * because it may have expired or been signed with a since-rotated secret. A
 * failed check silently falls back to issuing a fresh guest identity.
 */
export async function ensureGuestToken(name = ''): Promise<string | null> {
  const existing = storedToken();
  if (existing) {
    try {
      const response = await fetch(url('/auth/me'), {
        headers: { Authorization: `Bearer ${existing}` },
      });
      if (response.ok) return existing;
    } catch {
      /* Fall through and request a new one. */
    }
  }

  try {
    const response = await fetch(url('/auth/guest'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { token?: string };
    if (typeof body.token !== 'string') return null;

    storeToken(body.token);
    return body.token;
  } catch {
    return null;
  }
}

export async function listRooms(): Promise<RoomSummary[]> {
  const response = await fetch(url('/rooms'));
  if (!response.ok) return [];
  const body = (await response.json()) as { rooms?: RoomSummary[] };
  return body.rooms ?? [];
}

export async function createRoom(
  name: string,
  territoryCount: number,
): Promise<RoomSummary | null> {
  const token = storedToken();
  if (!token) return null;

  const response = await fetch(url('/rooms'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name, territoryCount }),
  });

  if (!response.ok) return null;
  const body = (await response.json()) as { room?: RoomSummary };
  return body.room ?? null;
}
