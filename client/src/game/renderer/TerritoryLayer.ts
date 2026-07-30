import { Container, Graphics } from 'pixi.js';
import {
  NEUTRAL_COLOR,
  OWNER_NONE,
  TERRAIN_COLORS,
  type WorldReader,
  playerColor,
} from '@borderfall/shared';
import type { Camera } from '../camera/Camera.js';

/**
 * Draws the territory map.
 *
 * ## The performance problem
 *
 * 5 000 territories at 60 fps rules out the obvious approaches. One `Graphics`
 * per territory means 5 000 scene-graph nodes for Pixi to transform and cull
 * every frame. A single `Graphics` for the whole map is worse in a different
 * way: any one territory changing owner forces all 5 000 polygons to be
 * re-tessellated.
 *
 * ## The approach: spatial chunks with dirty rebuild
 *
 * The world is divided into a grid of chunks, each owning one `Graphics` that
 * batches every polygon whose centroid falls inside it. That gives:
 *
 * - **Cheap updates.** A capture re-tessellates ~30 polygons (one chunk),
 *   not 5 000.
 * - **Cheap culling.** Off-screen chunks are hidden with a single `visible`
 *   flag, so the GPU never sees them.
 * - **A small scene graph.** ~250 nodes instead of 5 000.
 *
 * Redraws are driven entirely by a dirty set. A steady frame where nothing
 * changed does no geometry work at all — it only moves the camera transform.
 */

/**
 * Target chunk count along the longest axis.
 *
 * 16 gives ~256 chunks and ~20 territories each at 5 000 territories. Larger
 * chunks make rebuilds expensive; smaller ones inflate the scene graph and lose
 * the batching benefit.
 */
const CHUNK_GRID = 16;

interface Chunk {
  readonly graphics: Graphics;
  readonly territories: number[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  dirty: boolean;
}

export interface TerritoryLayerState {
  /** Owner slot per territory, or `OWNER_NONE`. */
  owner: Uint16Array;
  /** Territory under the cursor, or `-1`. */
  hovered: number;
  /** Currently selected territory, or `-1`. */
  selected: number;
}

export class TerritoryLayer {
  readonly container = new Container();

  private readonly chunks: Chunk[] = [];
  /** Chunk index per territory, for O(1) dirty marking on a state change. */
  private readonly chunkOfTerritory: Int32Array;

  /** Overlay for hover/selection, kept separate so it never dirties a chunk. */
  private readonly highlight = new Graphics();

  private lastHovered = -1;
  private lastSelected = -1;

  constructor(
    private readonly world: WorldReader,
    private readonly state: TerritoryLayerState,
  ) {
    this.chunkOfTerritory = new Int32Array(world.territoryCount);
    this.buildChunks();
    this.container.addChild(this.highlight);
  }

  private buildChunks(): void {
    const chunkWidth = this.world.width / CHUNK_GRID;
    const chunkHeight = this.world.height / CHUNK_GRID;

    for (let row = 0; row < CHUNK_GRID; row++) {
      for (let col = 0; col < CHUNK_GRID; col++) {
        const graphics = new Graphics();
        this.chunks.push({
          graphics,
          territories: [],
          minX: col * chunkWidth,
          minY: row * chunkHeight,
          maxX: (col + 1) * chunkWidth,
          maxY: (row + 1) * chunkHeight,
          dirty: true,
        });
        this.container.addChild(graphics);
      }
    }

    // Assign by centroid. A polygon may overlap a neighbouring chunk slightly;
    // that is harmless because chunk bounds are only used for culling, and the
    // culling margin below covers the overhang.
    for (let id = 0; id < this.world.territoryCount; id++) {
      const col = Math.min(
        CHUNK_GRID - 1,
        Math.max(0, Math.floor(this.world.getCentroidX(id) / chunkWidth)),
      );
      const row = Math.min(
        CHUNK_GRID - 1,
        Math.max(0, Math.floor(this.world.getCentroidY(id) / chunkHeight)),
      );
      const index = row * CHUNK_GRID + col;
      this.chunkOfTerritory[id] = index;
      (this.chunks[index] as Chunk).territories.push(id);
    }
  }

  /** Marks the chunk containing `territoryId` for rebuild on the next render. */
  invalidateTerritory(territoryId: number): void {
    const index = this.chunkOfTerritory[territoryId];
    if (index === undefined || index < 0) return;
    const chunk = this.chunks[index];
    if (chunk) chunk.dirty = true;
  }

  /** Marks every chunk dirty — used after a full snapshot replaces all state. */
  invalidateAll(): void {
    for (const chunk of this.chunks) chunk.dirty = true;
  }

  /**
   * Rebuilds dirty visible chunks and updates culling.
   *
   * Off-screen dirty chunks are deliberately left dirty rather than rebuilt:
   * they will be rebuilt when they scroll into view, which spreads the cost of
   * a large state change across frames instead of spiking on one.
   */
  render(camera: Camera): void {
    const view = camera.getViewBounds();

    // Margin so a chunk whose polygons overhang its bounds is not popped out
    // at the screen edge.
    const margin = Math.max(this.world.width, this.world.height) / CHUNK_GRID;
    const minX = view.minX - margin;
    const minY = view.minY - margin;
    const maxX = view.maxX + margin;
    const maxY = view.maxY + margin;

    for (const chunk of this.chunks) {
      const visible =
        chunk.maxX >= minX && chunk.minX <= maxX && chunk.maxY >= minY && chunk.minY <= maxY;

      chunk.graphics.visible = visible;
      if (!visible) continue;

      if (chunk.dirty) {
        this.rebuildChunk(chunk);
        chunk.dirty = false;
      }
    }

    if (this.state.hovered !== this.lastHovered || this.state.selected !== this.lastSelected) {
      this.rebuildHighlight();
      this.lastHovered = this.state.hovered;
      this.lastSelected = this.state.selected;
    }
  }

  private rebuildChunk(chunk: Chunk): void {
    const graphics = chunk.graphics;
    graphics.clear();

    for (const id of chunk.territories) {
      const vertexCount = this.world.getVertexCount(id);
      if (vertexCount < 3) continue;

      let first = true;
      this.world.forEachPolygonPoint(id, (x, y) => {
        if (first) {
          graphics.moveTo(x, y);
          first = false;
        } else {
          graphics.lineTo(x, y);
        }
      });
      graphics.closePath();

      graphics.fill({ color: this.colorFor(id) });
      // Hairline borders at a fixed world width. Pixi scales this with the
      // camera transform, which is what we want: borders thin out as you zoom
      // out rather than turning the map into a mesh of lines.
      graphics.stroke({ color: 0x0b1220, width: 1.5, alignment: 0.5 });
    }
  }

  /** Owner colour when claimed, terrain colour when neutral. */
  private colorFor(id: number): number {
    const owner = this.state.owner[id];
    if (owner === undefined || owner === OWNER_NONE) {
      return TERRAIN_COLORS[this.world.getTerrain(id)] ?? NEUTRAL_COLOR;
    }
    return playerColor(owner);
  }

  /**
   * Draws hover and selection outlines.
   *
   * Kept in a separate `Graphics` from the chunks because hover changes on
   * every mouse move. Folding it into chunk rendering would dirty — and
   * re-tessellate — a chunk of ~20 polygons on each pointer event.
   */
  private rebuildHighlight(): void {
    this.highlight.clear();

    const outline = (id: number, color: number, width: number): void => {
      if (id < 0 || !this.world.isValidId(id)) return;
      let first = true;
      this.world.forEachPolygonPoint(id, (x, y) => {
        if (first) {
          this.highlight.moveTo(x, y);
          first = false;
        } else {
          this.highlight.lineTo(x, y);
        }
      });
      this.highlight.closePath();
      this.highlight.stroke({ color, width, alignment: 0.5 });
    };

    if (this.state.hovered !== this.state.selected) {
      outline(this.state.hovered, 0xffffff, 3);
    }
    outline(this.state.selected, 0xffd166, 5);
  }

  destroy(): void {
    for (const chunk of this.chunks) chunk.graphics.destroy();
    this.chunks.length = 0;
    this.highlight.destroy();
    this.container.destroy({ children: true });
  }

  /** Diagnostics for the debug overlay. */
  get stats(): { chunks: number; visibleChunks: number } {
    let visible = 0;
    for (const chunk of this.chunks) if (chunk.graphics.visible) visible++;
    return { chunks: this.chunks.length, visibleChunks: visible };
  }
}
