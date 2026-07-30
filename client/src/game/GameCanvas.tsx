import { useEffect, useRef, useState } from 'react';
import type { WorldGeometry } from '@borderfall/shared';
import { GameRenderer, type FrameStats } from './renderer/GameRenderer.js';
import { summariseTerritory, useWorldStore } from '../store/worldStore.js';

/**
 * React host for the PixiJS renderer.
 *
 * The only job of this component is to own a DOM node and tie the renderer's
 * lifetime to it. It renders no game content — every territory is drawn by Pixi
 * inside the canvas. Rendering 5 000 territories as React elements would be
 * several orders of magnitude too slow, which is why the architecture keeps
 * this boundary strict.
 */
export function GameCanvas({ geometry }: { geometry: WorldGeometry }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const [stats, setStats] = useState<FrameStats | null>(null);

  const setSelected = useWorldStore((state) => state.setSelected);
  const setHovered = useWorldStore((state) => state.setHovered);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new GameRenderer(geometry, {
      onSelectionChanged: (id) => {
        setSelected(id < 0 ? null : summariseTerritory(geometry, id));
      },
      onHoverChanged: setHovered,
      onFrameStats: setStats,
    });
    rendererRef.current = renderer;

    // `init` is async (Pixi 8 requires it). The renderer guards internally
    // against completing after this effect has already been torn down.
    void renderer.init(host);

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
    // Re-creating the renderer on a new world is intended: a different map is a
    // different match, and reusing the GPU buffers across worlds would be a
    // source of stale geometry rather than a meaningful optimisation.
  }, [geometry, setSelected, setHovered]);

  return (
    <div className="relative size-full">
      <div ref={hostRef} className="size-full touch-none" />

      {stats && (
        <div
          data-testid="stats-overlay"
          className="pointer-events-none absolute bottom-3 left-3 rounded border border-slate-700/60 bg-slate-950/80 px-2.5 py-1.5 font-mono text-[11px] text-slate-400 backdrop-blur"
        >
          {/* Individually addressable so end-to-end tests can read a single
              metric. Matching on the combined text is ambiguous — ancestor
              elements contain it too. */}
          <span
            data-testid="stat-fps"
            className={stats.fps >= 55 ? 'text-emerald-400' : 'text-amber-400'}
          >
            {stats.fps} fps
          </span>
          <span className="mx-2 text-slate-600">|</span>
          <span data-testid="stat-chunks">{stats.visibleChunks} chunks</span>
          <span className="mx-2 text-slate-600">|</span>
          <span data-testid="stat-zoom">{stats.zoom.toFixed(2)}x</span>
        </div>
      )}
    </div>
  );
}
