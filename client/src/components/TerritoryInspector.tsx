import { useWorldStore } from '../store/worldStore.js';

/** Formats a multiplier as a signed percentage relative to a neutral 1.0. */
function modifierLabel(value: number): { text: string; tone: string } {
  const delta = Math.round((value - 1) * 100);
  if (delta === 0) return { text: 'baseline', tone: 'text-slate-400' };
  return {
    text: `${delta > 0 ? '+' : ''}${delta}%`,
    tone: delta > 0 ? 'text-emerald-400' : 'text-rose-400',
  };
}

/**
 * Details panel for the selected territory.
 *
 * Reads only the `selected` slice. Hover is intentionally *not* rendered here —
 * it changes on every pointer move, and re-rendering this panel at pointer
 * frequency would be pure waste. Hover feedback is drawn by the renderer as a
 * canvas outline instead.
 */
export function TerritoryInspector() {
  const selected = useWorldStore((state) => state.selected);

  if (!selected) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 text-xs text-slate-500 backdrop-blur">
        Click a territory to inspect it.
      </div>
    );
  }

  const defence = modifierLabel(selected.defenceMultiplier);
  const income = modifierLabel(selected.incomeMultiplier);
  const growth = modifierLabel(selected.growthMultiplier);

  return (
    <div className="w-64 rounded-lg border border-slate-800 bg-slate-900/85 p-4 backdrop-blur">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-slate-100">{selected.terrainName}</h3>
        <div className="flex items-center gap-2">
          {selected.contested && (
            <span className="rounded bg-rose-950/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rose-300">
              Under attack
            </span>
          )}
          <span className="numeric text-[11px] text-slate-500">#{selected.id}</span>
        </div>
      </div>

      <dl className="space-y-1.5 text-xs">
        <Row label="Population" value={selected.population.toLocaleString()} tone="text-sky-300" />
        <Row label="Troops" value={selected.troops.toLocaleString()} tone="text-rose-300" />
        <Row label="Borders" value={String(selected.neighbourCount)} />
        <Row label="Defence" value={defence.text} tone={defence.tone} />
        <Row label="Income" value={income.text} tone={income.tone} />
        <Row label="Growth" value={growth.text} tone={growth.tone} />
        <Row label="Building" value={selected.buildingName} />
      </dl>

      <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
        Values are from the moment you selected this territory. Buildings arrive in Phase 5.
      </p>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-400">{label}</dt>
      <dd className={`numeric ${tone ?? 'text-slate-200'}`}>{value}</dd>
    </div>
  );
}
