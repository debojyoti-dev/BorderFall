import { useEffect, useRef, useState } from 'react';
import { OWNER_NONE, WorldReader, type WorldGeometry } from '@borderfall/shared';
import { GameRenderer, type FrameStats } from './renderer/GameRenderer.js';
import { summariseTerritory, useWorldStore } from '../store/worldStore.js';
import type { MatchClient } from '../net/MatchClient.js';

/**
 * React host for the PixiJS renderer.
 *
 * Owns a DOM node, ties the renderer's lifetime to it, and translates clicks
 * into game intentions. It renders no game content — every territory is drawn
 * by Pixi inside the canvas, because 5 000 React elements would be several
 * orders of magnitude too slow.
 */
export function GameCanvas({
  geometry,
  match,
}: {
  geometry: WorldGeometry;
  match?: MatchClient | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const [stats, setStats] = useState<FrameStats | null>(null);

  const setSelected = useWorldStore((state) => state.setSelected);
  const setHovered = useWorldStore((state) => state.setHovered);

  /**
   * Currently selected source territory.
   *
   * A ref rather than state: it is read inside the renderer's click callback,
   * which is created once and would otherwise capture a stale value from the
   * render in which it was defined.
   */
  const selectedRef = useRef(-1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reader = new WorldReader(geometry);

    const renderer = new GameRenderer(geometry, {
      onTerritoryClick: (id, isSecondary) => {
        if (id < 0) return;

        // Right-click always clears, so there is a way out of a bad selection.
        if (isSecondary) {
          selectedRef.current = -1;
          renderer.setSelected(-1);
          setSelected(null);
          return;
        }

        const owner = match?.owner[id] ?? OWNER_NONE;
        const live = {
          owner,
          population: match?.population[id] ?? 0,
          troops: match?.troops[id] ?? 0,
          contested: (match?.contested[id] ?? 0) === 1,
        };
        const mine = match !== null && match !== undefined && owner === match.mySlot;
        const source = selectedRef.current;

        /**
         * Two-step order: select one of your own territories, then click an
         * adjacent one to attack it. Chosen over drag-to-attack because it
         * works identically with a mouse, a trackpad and touch, and because a
         * mis-drag on a dense map is far easier to do by accident than a
         * mis-click.
         */
        if (source >= 0 && source !== id && !mine && reader.areNeighbours(source, id)) {
          match?.attack(source, id, 0.5);
          return;
        }

        if (mine) {
          const next = source === id ? -1 : id;
          selectedRef.current = next;
          renderer.setSelected(next);
          setSelected(next < 0 ? null : summariseTerritory(geometry, next, live));
          return;
        }

        // Clicking a territory that is not yours just inspects it.
        selectedRef.current = -1;
        renderer.setSelected(id);
        setSelected(summariseTerritory(geometry, id, live));
      },
      onHoverChanged: setHovered,
      onFrameStats: setStats,
    });
    rendererRef.current = renderer;

    // `init` is async (Pixi 8 requires it); the renderer guards internally
    // against completing after this effect has been torn down.
    void renderer.init(host).then(() => {
      if (!match) return;
      renderer.attachOwnerBuffer(match.owner);

      // Start the player looking at their own land rather than at a
      // fit-to-world view of 5 000 cells with no indication which is theirs.
      for (let id = 0; id < match.owner.length; id++) {
        if (match.owner[id] === match.mySlot) {
          renderer.focusTerritory(id);
          selectedRef.current = id;
          // Keep the inspector consistent with the highlight: the renderer
          // outlining a territory while the panel says "click a territory"
          // reads as a bug.
          setSelected(
            summariseTerritory(geometry, id, {
              owner: match.mySlot,
              population: match.population[id] ?? 0,
              troops: match.troops[id] ?? 0,
              contested: false,
            }),
          );
          break;
        }
      }
    });

    return () => {
      renderer.destroy();
      rendererRef.current = null;
      selectedRef.current = -1;
    };
  }, [geometry, match, setSelected, setHovered]);

  /**
   * Bridges network updates into the renderer's dirty set.
   *
   * Registered as callbacks on the match client rather than through React
   * state, so a 20 Hz delta stream never triggers a re-render.
   */
  useEffect(() => {
    if (!match) return;

    const previousChanged = match.callbacks.onTerritoriesChanged;
    const previousResync = match.callbacks.onFullResync;

    match.callbacks.onTerritoriesChanged = (ids) => {
      rendererRef.current?.invalidateTerritories(ids);
      previousChanged?.(ids);
    };
    match.callbacks.onFullResync = () => {
      rendererRef.current?.invalidateAll();
      previousResync?.();
    };

    return () => {
      // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
      // optional property, so an absent previous handler is deleted rather
      // than written back as undefined.
      if (previousChanged) match.callbacks.onTerritoriesChanged = previousChanged;
      else delete match.callbacks.onTerritoriesChanged;

      if (previousResync) match.callbacks.onFullResync = previousResync;
      else delete match.callbacks.onFullResync;
    };
  }, [match]);

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
