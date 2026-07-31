import { Router, type Request, type Response } from 'express';
import {
  GameMode,
  MAX_ROOM_NAME_LENGTH,
  RoomVisibility,
  isValidRoomCode,
  randomSeed,
  sanitisePlayerName,
} from '@borderfall/shared';
import type { MatchManager } from '../../match/MatchManager.js';
import { issueGuestToken, verifyToken } from '../../services/auth.js';

/**
 * REST surface.
 *
 * Deliberately narrow: only things that are genuinely request/response shaped
 * live here — obtaining an identity and browsing rooms. Everything about a
 * running match flows over the socket, because it is stateful, bidirectional
 * and latency-sensitive.
 */
export function createRoutes(matches: MatchManager): Router {
  const router = Router();

  /* Auth ----------------------------------------------------------------- */

  /**
   * Issues a guest identity.
   *
   * No credential required by design — this is the front door for a browser
   * game, and gating the first click behind registration is the largest
   * avoidable source of drop-off.
   */
  router.post('/auth/guest', (req: Request, res: Response) => {
    const body = req.body as { name?: unknown } | undefined;
    const requested = typeof body?.name === 'string' ? body.name : '';
    const { token, identity } = issueGuestToken(requested);

    res.json({
      token,
      identity: {
        accountId: identity.accountId,
        name: identity.name,
        isGuest: identity.isGuest,
      },
    });
  });

  /** Confirms a token is still valid, so a returning client can skip re-auth. */
  router.get('/auth/me', (req: Request, res: Response) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }

    const identity = verifyToken(token);
    if (!identity) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    res.json({ identity });
  });

  /* Rooms ---------------------------------------------------------------- */

  router.get('/rooms', (_req: Request, res: Response) => {
    res.json({ rooms: matches.listPublic() });
  });

  router.get('/rooms/:code', (req: Request, res: Response) => {
    const code = req.params['code'] ?? '';
    if (!isValidRoomCode(code)) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }

    const match = matches.getByCode(code);
    if (!match) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({ room: matches.summarise(match) });
  });

  router.post('/rooms', (req: Request, res: Response) => {
    // Room creation mutates server state, so it requires a real identity even
    // though that identity may be a guest.
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token || !verifyToken(token)) {
      res.status(401).json({ error: 'unauthorised' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const name =
      typeof body['name'] === 'string'
        ? sanitisePlayerName(body['name']).slice(0, MAX_ROOM_NAME_LENGTH)
        : 'Custom Match';

    const password = typeof body['password'] === 'string' ? body['password'] : undefined;
    const visibility =
      password && password.length > 0
        ? RoomVisibility.PasswordProtected
        : body['private'] === true
          ? RoomVisibility.Private
          : RoomVisibility.Public;

    // Every numeric field is clamped inside MatchManager.create; passing raw
    // client values straight through would let a request ask for a 10-million
    // territory world and exhaust the process.
    const match = matches.create({
      name: name.length > 0 ? name : 'Custom Match',
      mode: parseMode(body['mode']),
      visibility,
      password,
      maxPlayers: toNumber(body['maxPlayers'], 64),
      territoryCount: toNumber(body['territoryCount'], 2500),
      seed: toNumber(body['seed'], randomSeed()),
      botCount: toNumber(body['botCount'], 0),
    });

    if (!match) {
      res.status(503).json({ error: 'at_capacity' });
      return;
    }

    res.status(201).json({ room: matches.summarise(match) });
  });

  return router;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseMode(value: unknown): GameMode {
  const modes: GameMode[] = [
    GameMode.FreeForAll,
    GameMode.Domination,
    GameMode.Practice,
    GameMode.Ranked,
    GameMode.TeamBattle,
  ];
  return typeof value === 'number' && modes.includes(value as GameMode)
    ? (value as GameMode)
    : GameMode.FreeForAll;
}
