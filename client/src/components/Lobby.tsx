import { useEffect, useState } from 'react';
import type { RoomSummary } from '@borderfall/shared';
import { useMatchStore } from '../store/matchStore.js';

const MODE_NAMES: Readonly<Record<number, string>> = {
  0: 'Free for all',
  1: 'Domination',
  2: 'Practice',
  3: 'Ranked',
  4: 'Team battle',
};

const STATE_NAMES: Readonly<Record<number, string>> = {
  0: 'Lobby',
  1: 'Starting',
  2: 'In progress',
  3: 'Ending',
  4: 'Finished',
};

export interface LobbyProps {
  onQuickPlay: () => void;
  onJoinRoom: (roomId: string, password?: string) => void;
  onCreateRoom: (name: string, territoryCount: number) => void;
  onRefresh: () => void;
}

/**
 * Room browser and entry point.
 *
 * Quick Play is the primary action and joins the *fullest* room with space —
 * spreading players across many half-empty rooms is what makes a session game
 * feel dead at low population.
 */
export function Lobby({ onQuickPlay, onJoinRoom, onCreateRoom, onRefresh }: LobbyProps) {
  const rooms = useMatchStore((state) => state.rooms);
  const loading = useMatchStore((state) => state.roomsLoading);
  const phase = useMatchStore((state) => state.phase);
  const error = useMatchStore((state) => state.error);

  const [roomName, setRoomName] = useState('My Match');
  const [territoryCount, setTerritoryCount] = useState(2500);
  const [joinCode, setJoinCode] = useState('');

  useEffect(() => {
    onRefresh();
    // Poll while the browser is open so counts stay live without a socket
    // subscription for something viewed for only a few seconds.
    const timer = setInterval(onRefresh, 5000);
    return () => clearInterval(timer);
  }, [onRefresh]);

  const joining = phase === 'joining';

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-100">Play</h2>
        <p className="mt-1 text-sm text-slate-400">
          Claim territory, out-produce your neighbours, and take the map.
        </p>
      </div>

      {error && (
        <div className="rounded border border-rose-900/60 bg-rose-950/40 px-4 py-2.5 text-sm text-rose-300">
          {error}
        </div>
      )}

      <button
        onClick={onQuickPlay}
        disabled={joining}
        data-testid="quick-play"
        className="rounded-lg bg-sky-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
      >
        {joining ? 'Joining…' : 'Quick play'}
      </button>

      {/* Join by code -------------------------------------------------- */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <h3 className="mb-3 text-sm font-medium text-slate-200">Join with a code</h3>
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
            placeholder="ABC234"
            maxLength={10}
            data-testid="join-code"
            className="numeric flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm uppercase text-slate-200 outline-none focus:border-sky-600"
          />
          <button
            onClick={() => joinCode.length >= 4 && onJoinRoom(joinCode)}
            disabled={joining || joinCode.length < 4}
            className="rounded border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Join
          </button>
        </div>
      </section>

      {/* Create -------------------------------------------------------- */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <h3 className="mb-3 text-sm font-medium text-slate-200">Create a match</h3>
        <div className="flex flex-wrap gap-2">
          <input
            value={roomName}
            onChange={(event) => setRoomName(event.target.value)}
            maxLength={32}
            data-testid="room-name"
            className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-600"
          />
          <select
            value={territoryCount}
            onChange={(event) => setTerritoryCount(Number(event.target.value))}
            className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-600"
          >
            <option value={800}>Small — 800</option>
            <option value={2500}>Medium — 2,500</option>
            <option value={5000}>Large — 5,000</option>
          </select>
          <button
            onClick={() => onCreateRoom(roomName, territoryCount)}
            disabled={joining}
            data-testid="create-room"
            className="rounded border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </section>

      {/* Browser ------------------------------------------------------- */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-200">Open matches</h3>
          <span className="text-xs text-slate-500">
            {loading ? 'Refreshing…' : `${rooms.length} available`}
          </span>
        </div>

        {rooms.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No matches yet — quick play will start one.
          </p>
        ) : (
          <ul className="space-y-1.5" data-testid="room-list">
            {rooms.map((room) => (
              <RoomRow key={room.id} room={room} onJoin={onJoinRoom} disabled={joining} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RoomRow({
  room,
  onJoin,
  disabled,
}: {
  room: RoomSummary;
  onJoin: (roomId: string, password?: string) => void;
  disabled: boolean;
}) {
  const full = room.playerCount + room.botCount >= room.maxPlayers;

  return (
    <li className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm text-slate-200">{room.name}</span>
          <span className="numeric text-[11px] text-slate-500">{room.code}</span>
        </div>
        <div className="text-[11px] text-slate-500">
          {MODE_NAMES[room.mode] ?? 'Match'} · {STATE_NAMES[room.state] ?? ''} ·{' '}
          {room.territoryCount.toLocaleString()} territories
          {room.requiresPassword && ' · locked'}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="numeric text-xs text-slate-400">
          {room.playerCount}/{room.maxPlayers}
        </span>
        <button
          onClick={() => onJoin(room.id)}
          disabled={disabled || full}
          className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40"
        >
          {full ? 'Full' : 'Join'}
        </button>
      </div>
    </li>
  );
}
