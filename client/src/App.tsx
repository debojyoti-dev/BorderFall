import { useCallback, useEffect, useRef, useState } from 'react';
import { PROTOCOL_VERSION, type WorldGeometry } from '@borderfall/shared';
import { ConnectionBadge } from './components/ConnectionBadge.js';
import { Leaderboard, ResourceBar } from './components/MatchHud.js';
import { Lobby } from './components/Lobby.js';
import { TerritoryInspector } from './components/TerritoryInspector.js';
import { GameCanvas } from './game/GameCanvas.js';
import { MatchClient } from './net/MatchClient.js';
import { installDebugHooks } from './net/debug.js';
import * as api from './net/api.js';
import { socketClient, useConnectionStore } from './store/connectionStore.js';
import { useMatchStore } from './store/matchStore.js';

/**
 * Application shell.
 *
 * Two screens: the lobby and a live match. The world is rebuilt locally from
 * the seed in `match:init` — the same code path Phase 2 exercised with a text
 * box, now driven by the server. That the client-side path did not change when
 * multiplayer landed is the point of the seed-replication design.
 */
export function App() {
  const connect = useConnectionStore((state) => state.connect);
  const status = useConnectionStore((state) => state.status);

  const phase = useMatchStore((state) => state.phase);
  const setPhase = useMatchStore((state) => state.setPhase);
  const setRooms = useMatchStore((state) => state.setRooms);
  const setRoomsLoading = useMatchStore((state) => state.setRoomsLoading);
  const setPlayers = useMatchStore((state) => state.setPlayers);
  const setResources = useMatchStore((state) => state.setResources);
  const setLeaderboard = useMatchStore((state) => state.setLeaderboard);
  const setRejection = useMatchStore((state) => state.setRejection);
  const setMySlot = useMatchStore((state) => state.setMySlot);
  const setError = useMatchStore((state) => state.setError);

  const [geometry, setGeometry] = useState<WorldGeometry | null>(null);
  const matchRef = useRef<MatchClient | null>(null);

  /* Connect and authenticate once, at start-up. ------------------------- */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // A guest identity is obtained before connecting so the socket handshake
      // carries a token and the server never has to deal with an unidentified
      // connection.
      const token = await api.ensureGuestToken();
      if (cancelled) return;

      connect(token ? { token } : undefined);

      const client = new MatchClient(socketClient, {
        onPlayers: setPlayers,
        onResources: setResources,
        onLeaderboard: setLeaderboard,
        onCommandRejected: (_seq, reason) => {
          setRejection(reason);
          // Clear after a moment so the bar does not accumulate stale errors.
          setTimeout(() => setRejection(null), 2500);
        },
        onNotice: (text, severity) => {
          if (severity === 'error') setError(text);
        },
      });
      client.attach();
      matchRef.current = client;
      installDebugHooks(client);
    })();

    return () => {
      cancelled = true;
    };
  }, [connect, setPlayers, setResources, setLeaderboard, setRejection, setError]);

  /* Lobby actions -------------------------------------------------------- */

  const refreshRooms = useCallback(async () => {
    setRoomsLoading(true);
    try {
      setRooms(await api.listRooms());
    } catch {
      // A failed refresh is not worth an error banner — the list simply stays
      // as it was and the next poll will retry.
    } finally {
      setRoomsLoading(false);
    }
  }, [setRooms, setRoomsLoading]);

  const join = useCallback(
    async (roomId: string, password?: string) => {
      const client = matchRef.current;
      if (!client) return;

      setPhase('joining');
      setError(null);

      const result = await client.join(roomId, password);
      if (!result) {
        setPhase('lobby');
        setError('Could not join that match.');
        return;
      }

      setMySlot(result.yourSlot);
      setGeometry(client.geometry);
      setPhase('playing');
    },
    [setPhase, setError, setMySlot],
  );

  const createRoom = useCallback(
    async (name: string, territoryCount: number) => {
      setPhase('joining');
      try {
        const room = await api.createRoom(name, territoryCount);
        if (!room) throw new Error('create failed');
        await join(room.id);
      } catch {
        setPhase('lobby');
        setError('Could not create the match.');
      }
    },
    [join, setPhase, setError],
  );

  const leave = useCallback(() => {
    matchRef.current?.leave(true);
    setGeometry(null);
    setPhase('lobby');
    setMySlot(-1);
  }, [setPhase, setMySlot]);

  const inMatch = phase === 'playing' && geometry !== null;

  return (
    <div className="flex h-full flex-col bg-slate-950">
      <header className="z-10 flex items-center justify-between border-b border-slate-800 px-5 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold tracking-tight text-slate-100">BorderFall</h1>
          <span className="text-[11px] text-slate-500">protocol v{PROTOCOL_VERSION}</span>
        </div>

        <div className="flex items-center gap-3">
          {inMatch && <ResourceBar />}
          {inMatch && (
            <button
              onClick={leave}
              data-testid="leave-match"
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
            >
              Leave
            </button>
          )}
          <ConnectionBadge />
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden">
        {inMatch ? (
          <>
            <GameCanvas geometry={geometry} match={matchRef.current} />
            <div className="hud-layer absolute right-4 top-4 flex flex-col gap-3">
              <Leaderboard />
              <TerritoryInspector />
            </div>
            <div className="hud-layer absolute bottom-3 right-4">
              <p className="rounded border border-slate-800 bg-slate-900/85 px-3 py-2 text-[11px] text-slate-400 backdrop-blur">
                Click your territory, then an adjacent one to attack. Right-click to clear.
              </p>
            </div>
          </>
        ) : status === 'connected' || status === 'reconnecting' ? (
          <Lobby
            onQuickPlay={() => void join('')}
            onJoinRoom={(roomId, password) => void join(roomId, password)}
            onCreateRoom={(name, count) => void createRoom(name, count)}
            onRefresh={() => void refreshRooms()}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-slate-500">
            Connecting to the server…
          </div>
        )}
      </main>
    </div>
  );
}
