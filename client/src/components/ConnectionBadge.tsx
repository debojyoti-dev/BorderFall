import { selectLatency, selectStatus, useConnectionStore } from '../store/connectionStore.js';
import type { ConnectionStatus } from '../socket/SocketClient.js';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  failed: 'Connection failed',
};

const STATUS_DOT: Record<ConnectionStatus, string> = {
  idle: 'bg-slate-500',
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-400',
  reconnecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-rose-500',
  failed: 'bg-rose-500',
};

/** Colour-codes latency against the sub-100 ms target. */
function latencyTone(latencyMs: number): string {
  if (latencyMs <= 0) return 'text-slate-500';
  if (latencyMs < 60) return 'text-emerald-400';
  if (latencyMs < 120) return 'text-amber-400';
  return 'text-rose-400';
}

/**
 * Live connection indicator.
 *
 * Subscribes to two narrow slices rather than the whole store: a component that
 * selected the entire state would re-render on every latency probe, twice a
 * second, for the lifetime of the session.
 */
export function ConnectionBadge() {
  const status = useConnectionStore(selectStatus);
  const latency = useConnectionStore(selectLatency);

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-900/80 px-3 py-1.5 text-xs backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <span className={`size-2 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
      <span className="text-slate-300">{STATUS_LABEL[status]}</span>
      {status === 'connected' && (
        <span className={`numeric ${latencyTone(latency)}`}>
          {latency}
          <span className="text-slate-500">ms</span>
        </span>
      )}
    </div>
  );
}
