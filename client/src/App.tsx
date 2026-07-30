import { useEffect, useState } from 'react';
import { PROTOCOL_VERSION, randomSeed } from '@borderfall/shared';
import { ConnectionBadge } from './components/ConnectionBadge.js';
import { TerritoryInspector } from './components/TerritoryInspector.js';
import { GameCanvas } from './game/GameCanvas.js';
import { useConnectionStore } from './store/connectionStore.js';
import { useWorldStore } from './store/worldStore.js';

/**
 * Application shell.
 *
 * Phase 2 scope: a procedurally generated world, rendered and navigable. The
 * map is generated *locally* from a seed — exactly as it will be in Phase 3,
 * except that the seed will then come from the server's `match:init` packet
 * instead of a button. That is the point of the seed-replication design: the
 * client-side code path does not change when multiplayer lands.
 */
export function App() {
  const connect = useConnectionStore((state) => state.connect);
  const disconnect = useConnectionStore((state) => state.disconnect);

  const geometry = useWorldStore((state) => state.geometry);
  const params = useWorldStore((state) => state.params);
  const generating = useWorldStore((state) => state.generating);
  const generationMs = useWorldStore((state) => state.generationMs);
  const generate = useWorldStore((state) => state.generate);

  const [seedInput, setSeedInput] = useState('2026');

  useEffect(() => {
    connect();
    return () => {
      // See the note in Phase 1: the socket is a page-lifetime resource, and
      // Strict Mode's double mount would otherwise tear it down permanently.
      if (import.meta.env.PROD) disconnect();
    };
  }, [connect, disconnect]);

  // Generate an initial world on first mount so there is something to look at.
  useEffect(() => {
    if (!geometry) generate(2026);
  }, [geometry, generate]);

  const handleGenerate = () => {
    const parsed = Number.parseInt(seedInput, 10);
    generate(Number.isFinite(parsed) ? parsed : randomSeed());
  };

  const handleRandom = () => {
    const seed = randomSeed();
    setSeedInput(String(seed));
    generate(seed);
  };

  return (
    <div className="flex h-full flex-col bg-slate-950">
      <header className="z-10 flex items-center justify-between border-b border-slate-800 px-5 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold tracking-tight text-slate-100">BorderFall</h1>
          <span className="text-[11px] text-slate-500">protocol v{PROTOCOL_VERSION}</span>
        </div>

        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="seed">
            Map seed
          </label>
          <input
            id="seed"
            value={seedInput}
            onChange={(event) => setSeedInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleGenerate();
            }}
            className="numeric w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-600"
            placeholder="seed"
          />
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Generate
          </button>
          <button
            onClick={handleRandom}
            disabled={generating}
            className="rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Random
          </button>
          <ConnectionBadge />
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden">
        {geometry ? (
          <GameCanvas geometry={geometry} />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-slate-500">
            Generating world…
          </div>
        )}

        <div
          data-testid="hud-panels"
          className="hud-layer absolute right-4 top-4 flex flex-col gap-3"
        >
          <TerritoryInspector />

          {geometry && params && (
            <div className="w-64 rounded-lg border border-slate-800 bg-slate-900/85 p-4 text-xs backdrop-blur">
              <h3 className="mb-2 text-sm font-medium text-slate-100">World</h3>
              <dl className="space-y-1.5">
                <Row label="Seed" value={String(params.seed)} />
                <Row label="Territories" value={geometry.territoryCount.toLocaleString()} />
                <Row label="Spawns" value={String(geometry.spawnCandidates.length)} />
                <Row label="Generated in" value={`${generationMs} ms`} />
              </dl>
              <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
                Drag to pan, scroll to zoom, click to select. The server sends only this seed — the
                map is rebuilt locally.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-400">{label}</dt>
      <dd className="numeric text-slate-200">{value}</dd>
    </div>
  );
}
