import { create } from 'zustand';
import {
  REJECT_REASON_TEXT,
  type LeaderboardEntry,
  type PlayerResourcesView,
  type PlayerView,
  type RoomSummary,
} from '@borderfall/shared';

/**
 * Match session state for the UI.
 *
 * Holds only what a human reads. The territory arrays live in `MatchClient` and
 * are consumed directly by the renderer; routing 5 000 entries through a React
 * store at 20 Hz would trigger a reconciliation pass per network tick.
 *
 * Note the asymmetry: `resources` and `leaderboard` update a few times a second
 * and belong here; `owner` and `troops` update constantly and do not.
 */

export type MatchPhase = 'lobby' | 'joining' | 'playing' | 'error';

interface MatchState {
  phase: MatchPhase;
  rooms: RoomSummary[];
  roomsLoading: boolean;

  mySlot: number;
  players: PlayerView[];
  resources: PlayerResourcesView | null;
  leaderboard: LeaderboardEntry[];

  /** Transient message shown after a rejected command. */
  lastRejection: string | null;
  error: string | null;

  setPhase: (phase: MatchPhase) => void;
  setRooms: (rooms: RoomSummary[]) => void;
  setRoomsLoading: (loading: boolean) => void;
  setMySlot: (slot: number) => void;
  setPlayers: (players: readonly PlayerView[]) => void;
  setResources: (resources: PlayerResourcesView) => void;
  setLeaderboard: (entries: readonly LeaderboardEntry[]) => void;
  setRejection: (reason: number | null) => void;
  setError: (message: string | null) => void;
  reset: () => void;
}

const INITIAL = {
  phase: 'lobby' as MatchPhase,
  rooms: [] as RoomSummary[],
  roomsLoading: false,
  mySlot: -1,
  players: [] as PlayerView[],
  resources: null,
  leaderboard: [] as LeaderboardEntry[],
  lastRejection: null,
  error: null,
};

export const useMatchStore = create<MatchState>((set) => ({
  ...INITIAL,

  setPhase: (phase) => set({ phase }),
  setRooms: (rooms) => set({ rooms }),
  setRoomsLoading: (roomsLoading) => set({ roomsLoading }),
  setMySlot: (mySlot) => set({ mySlot }),
  setPlayers: (players) => set({ players: [...players] }),
  setResources: (resources) => set({ resources }),
  setLeaderboard: (entries) => set({ leaderboard: [...entries] }),

  setRejection: (reason) =>
    set({
      // The server sends a numeric code, never prose — the client owns the
      // wording so it can be localised and so the server leaks no state.
      lastRejection:
        reason === null
          ? null
          : (REJECT_REASON_TEXT[reason] ?? REJECT_REASON_TEXT[0] ?? 'Action failed.'),
    }),

  setError: (error) => set({ error }),
  reset: () => set(INITIAL),
}));
