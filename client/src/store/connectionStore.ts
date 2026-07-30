import { create } from 'zustand';
import {
  SocketClient,
  type ConnectionStatus,
  type NetworkQuality,
} from '../socket/SocketClient.js';

/**
 * Connection state, exposed to React.
 *
 * ## Why the socket lives outside the store
 *
 * Zustand holds *serialisable observations* about the connection — status,
 * latency — not the connection itself. The `SocketClient` is a module-level
 * singleton because it must outlive every component that observes it. Putting a
 * live socket in React state invites re-render churn and, under Strict Mode's
 * double-mount, a torn-down game connection.
 *
 * ## Why high-frequency game state will *not* live in Zustand
 *
 * This store is updated a few times per second at most. World state arrives at
 * 20 Hz across thousands of territories; routing that through a React store
 * would trigger a reconciliation pass per network tick and destroy the 60 fps
 * budget. From Phase 2 onward, world state is written directly into typed
 * arrays that the PixiJS renderer reads each frame, and only *derived summaries*
 * a human reads (selected territory, resource totals, leaderboard) are mirrored
 * into React. That split is the core of the client architecture.
 */

interface ConnectionState {
  status: ConnectionStatus;
  quality: NetworkQuality;
  /** Populated when the server rejects or drops the connection. */
  lastError: string | null;

  connect: (auth?: Record<string, string>) => void;
  disconnect: () => void;
  setStatus: (status: ConnectionStatus) => void;
  setQuality: (quality: NetworkQuality) => void;
  setError: (message: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'idle',
  quality: { latencyMs: 0, clockOffsetMs: 0, jitterMs: 0 },
  lastError: null,

  connect: (auth) => {
    socketClient.connect(auth);
  },
  disconnect: () => {
    socketClient.disconnect();
  },
  setStatus: (status) => set({ status }),
  setQuality: (quality) => set({ quality }),
  setError: (lastError) => set({ lastError }),
}));

/**
 * The application's single socket.
 *
 * Created at module scope so it is constructed once per page load, before any
 * component mounts. Callbacks push into the store rather than the store pulling
 * from the client, which keeps the client free of any React dependency and
 * therefore testable in a plain Node environment.
 */
export const socketClient = new SocketClient({
  onStatusChange: (status) => {
    useConnectionStore.getState().setStatus(status);
    if (status === 'failed') {
      useConnectionStore.getState().setError('Could not reach the game server.');
    } else if (status === 'connected') {
      useConnectionStore.getState().setError(null);
    }
  },
  onQualityChange: (quality) => useConnectionStore.getState().setQuality(quality),
});

/* Selectors — subscribing to a slice avoids re-rendering on unrelated changes. */
export const selectStatus = (state: ConnectionState): ConnectionStatus => state.status;
export const selectLatency = (state: ConnectionState): number => state.quality.latencyMs;
