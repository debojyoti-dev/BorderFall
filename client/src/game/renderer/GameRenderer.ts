import { Application, Container } from 'pixi.js';
import { OWNER_NONE, type WorldGeometry, WorldReader } from '@borderfall/shared';
import { Camera } from '../camera/Camera.js';
import { PointerController } from '../input/PointerController.js';
import { TerritoryLayer, type TerritoryLayerState } from './TerritoryLayer.js';

/**
 * Owns the Pixi application and drives the frame loop.
 *
 * Deliberately a plain class, constructed and destroyed by a thin React
 * wrapper. React manages the DOM node's lifecycle and nothing else — every
 * frame of rendering happens outside React's reconciler, which is the only way
 * to hold 60 fps with 5 000 territories.
 */

export interface RendererCallbacks {
  onSelectionChanged?(territoryId: number): void;
  onHoverChanged?(territoryId: number): void;
  onFrameStats?(stats: FrameStats): void;
}

export interface FrameStats {
  fps: number;
  /** Milliseconds spent in the frame callback. */
  frameMs: number;
  visibleChunks: number;
  zoom: number;
}

export class GameRenderer {
  private app: Application | null = null;
  private camera: Camera;
  private world: WorldReader;
  private territoryLayer: TerritoryLayer | null = null;
  private pointer: PointerController | null = null;

  /** The world stage, transformed by the camera each frame. */
  private readonly stage = new Container();

  private readonly state: TerritoryLayerState;

  private resizeObserver: ResizeObserver | null = null;
  private lastFrameTime = 0;

  /** Rolling frame-time accumulator for a stable fps readout. */
  private frameAccumulator = 0;
  private frameCount = 0;
  private destroyed = false;

  constructor(
    geometry: WorldGeometry,
    private readonly callbacks: RendererCallbacks = {},
  ) {
    this.world = new WorldReader(geometry);
    this.camera = new Camera({ width: this.world.width, height: this.world.height });

    this.state = {
      // Phase 2 has no server state yet, so every territory starts neutral and
      // renders in its terrain colour. Phase 3 replaces this array wholesale
      // from the snapshot packet.
      owner: new Uint16Array(this.world.territoryCount).fill(OWNER_NONE),
      hovered: -1,
      selected: -1,
    };
  }

  async init(container: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      resizeTo: container,
      antialias: true,
      background: 0x0a1020,
      // Cap at 2 — beyond that the fill-rate cost on a 4K display outweighs any
      // visible improvement on polygon edges.
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: 'high-performance',
    });

    // `init` is async; the component may have unmounted while it was pending.
    if (this.destroyed) {
      app.destroy(true, { children: true });
      return;
    }

    this.app = app;
    container.appendChild(app.canvas);

    this.territoryLayer = new TerritoryLayer(this.world, this.state);
    this.stage.addChild(this.territoryLayer.container);
    app.stage.addChild(this.stage);

    this.camera.resize(app.screen.width, app.screen.height);
    this.camera.fitToWorld();

    this.pointer = new PointerController(app.canvas, this.camera, this.world, {
      onHover: (id) => {
        if (this.state.hovered === id) return;
        this.state.hovered = id;
        this.callbacks.onHoverChanged?.(id);
      },
      onSelect: (id) => {
        this.state.selected = this.state.selected === id ? -1 : id;
        this.callbacks.onSelectionChanged?.(this.state.selected);
      },
      onContext: () => {
        this.state.selected = -1;
        this.callbacks.onSelectionChanged?.(-1);
      },
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.app) return;
      this.camera.resize(this.app.screen.width, this.app.screen.height);
    });
    this.resizeObserver.observe(container);

    this.lastFrameTime = performance.now();
    app.ticker.add(this.onFrame);
  }

  private onFrame = (): void => {
    if (!this.app || !this.territoryLayer) return;

    const now = performance.now();
    // Clamp the delta so a backgrounded tab resuming after 30 s does not
    // teleport the camera across the map in a single frame.
    const deltaSeconds = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    this.camera.update(deltaSeconds);
    this.applyCameraTransform();
    this.territoryLayer.render(this.camera);

    this.frameAccumulator += deltaSeconds;
    this.frameCount++;
    if (this.frameAccumulator >= 0.5) {
      this.callbacks.onFrameStats?.({
        fps: Math.round(this.frameCount / this.frameAccumulator),
        frameMs: Math.round((this.frameAccumulator / this.frameCount) * 10000) / 10,
        visibleChunks: this.territoryLayer.stats.visibleChunks,
        zoom: Math.round(this.camera.zoom * 1000) / 1000,
      });
      this.frameAccumulator = 0;
      this.frameCount = 0;
    }
  };

  /**
   * Maps world space onto screen space with a single container transform.
   *
   * Doing this once on the parent — rather than repositioning 5 000 children —
   * is what makes panning and zooming essentially free: the GPU applies one
   * matrix and the scene graph is untouched.
   */
  private applyCameraTransform(): void {
    const { width, height } = this.camera.viewport;
    this.stage.scale.set(this.camera.zoom);
    this.stage.position.set(
      -this.camera.x * this.camera.zoom + width / 2,
      -this.camera.y * this.camera.zoom + height / 2,
    );
  }

  /** Replaces owner state and invalidates affected chunks. Used from Phase 3. */
  setOwners(owner: Uint16Array): void {
    this.state.owner = owner;
    this.territoryLayer?.invalidateAll();
  }

  /** Applies a single ownership change, dirtying only the affected chunk. */
  setOwner(territoryId: number, ownerSlot: number): void {
    if (this.state.owner[territoryId] === ownerSlot) return;
    this.state.owner[territoryId] = ownerSlot;
    this.territoryLayer?.invalidateTerritory(territoryId);
  }

  getCamera(): Camera {
    return this.camera;
  }

  getWorld(): WorldReader {
    return this.world;
  }

  get selectedTerritory(): number {
    return this.state.selected;
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.pointer?.destroy();
    this.pointer = null;

    this.app?.ticker.remove(this.onFrame);
    this.territoryLayer?.destroy();
    this.territoryLayer = null;

    // `destroy(true, ...)` also removes the canvas from the DOM.
    this.app?.destroy(true, { children: true });
    this.app = null;
  }
}
