import { playerColor, toHexString } from '@borderfall/shared';
import { useMatchStore } from '../store/matchStore.js';

/** Compact number formatting so wide empires do not overflow the panels. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.floor(value));
}

/** Resource bar for the local player. */
export function ResourceBar() {
  const resources = useMatchStore((state) => state.resources);
  const rejection = useMatchStore((state) => state.lastRejection);

  if (!resources) return null;

  return (
    <div className="flex items-center gap-4 rounded-lg border border-slate-800 bg-slate-900/85 px-4 py-2 text-xs backdrop-blur">
      <Stat label="Gold" value={compact(resources.gold)} tone="text-amber-300" />
      <Stat label="Food" value={compact(resources.food)} tone="text-lime-300" />
      <Stat label="Pop" value={compact(resources.population)} tone="text-sky-300" />
      <Stat label="Troops" value={compact(resources.troops)} tone="text-rose-300" />
      <Stat label="Land" value={String(resources.territoryCount)} tone="text-slate-200" />

      {rejection && (
        <span className="ml-2 rounded bg-rose-950/60 px-2 py-0.5 text-[11px] text-rose-300">
          {rejection}
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-slate-500">{label}</span>
      <span className={`numeric ${tone}`}>{value}</span>
    </div>
  );
}

/**
 * Live standings.
 *
 * Public by design — shared context is what makes diplomacy possible. Only
 * aggregates are shown, never the per-territory detail that would let a player
 * pinpoint an opponent's weakest holding.
 */
export function Leaderboard() {
  const entries = useMatchStore((state) => state.leaderboard);
  const mySlot = useMatchStore((state) => state.mySlot);

  if (entries.length === 0) return null;

  return (
    <div className="w-60 rounded-lg border border-slate-800 bg-slate-900/85 p-3 backdrop-blur">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Standings</h3>
      <ol className="space-y-1" data-testid="leaderboard">
        {entries.slice(0, 10).map((entry) => (
          <li
            key={entry.slot}
            className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${
              entry.slot === mySlot ? 'bg-slate-800/80' : ''
            }`}
          >
            <span className="numeric w-4 text-slate-500">{entry.rank}</span>
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: toHexString(playerColor(entry.slot)) }}
              aria-hidden="true"
            />
            <span className="flex-1 truncate text-slate-200">
              {entry.name}
              {entry.isBot && <span className="ml-1 text-slate-500">bot</span>}
            </span>
            <span className="numeric text-slate-400">
              {(entry.territoryShare * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
