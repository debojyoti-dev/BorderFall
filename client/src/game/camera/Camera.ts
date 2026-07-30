import { clamp, damp } from '@borderfall/shared';

/**
 * Viewport camera: pan, zoom, inertia and world/screen conversion.
 *
 * Pure state and maths — it owns no Pixi objects and reads no DOM events. The
 * renderer applies its transform, the input controller drives it. That keeps it
 * unit-testable without a canvas, which matters because the frame-rate
 * independence below is exactly the kind of thing that silently regresses.
 */

export interface CameraBounds {
  readonly width: number;
  readonly height: number;
}

export interface CameraOptions {
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Fraction of velocity retained after one second of coasting. */
  readonly friction?: number;
  /** Fraction of remaining distance left after one second of smoothing. */
  readonly smoothing?: number;
}

export class Camera {
  /** Centre of the viewport, in world coordinates. */
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  zoom = 1;

  /** Targets the camera eases toward; set by input, read by `update`. */
  private targetX: number;
  private targetY: number;
  private targetZoom = 1;

  /** Pan velocity in world units per second, for post-drag inertia. */
  private velocityX = 0;
  private velocityY = 0;

  private viewportWidth = 1;
  private viewportHeight = 1;

  private minZoom: number;
  private readonly maxZoom: number;
  private readonly friction: number;
  private readonly smoothing: number;

  /** Set whenever the transform changes, so the renderer can skip idle frames. */
  private dirty = true;

  constructor(
    private readonly bounds: CameraBounds,
    options: CameraOptions = {},
  ) {
    this.x = bounds.width / 2;
    this.y = bounds.height / 2;
    this.targetX = this.x;
    this.targetY = this.y;

    this.minZoom = options.minZoom ?? 0.05;
    this.maxZoom = options.maxZoom ?? 8;
    this.friction = options.friction ?? 0.0005;
    this.smoothing = options.smoothing ?? 0.000001;
  }

  /**
   * Informs the camera of the canvas size.
   *
   * Also recomputes the minimum zoom so the world can never be smaller than the
   * viewport — zooming out past that would render the map floating in a void
   * and makes the clamping in {@link constrain} meaningless.
   */
  resize(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);

    const fitZoom = Math.max(
      this.viewportWidth / this.bounds.width,
      this.viewportHeight / this.bounds.height,
    );
    this.minZoom = fitZoom;
    if (this.targetZoom < fitZoom) this.targetZoom = fitZoom;
    if (this.zoom < fitZoom) this.zoom = fitZoom;

    this.constrain();
    this.dirty = true;
  }

  /** Frames the entire world in view. */
  fitToWorld(): void {
    this.targetZoom = Math.max(
      this.viewportWidth / this.bounds.width,
      this.viewportHeight / this.bounds.height,
    );
    this.zoom = this.targetZoom;
    this.targetX = this.bounds.width / 2;
    this.targetY = this.bounds.height / 2;
    this.x = this.targetX;
    this.y = this.targetY;
    this.velocityX = 0;
    this.velocityY = 0;
    this.constrain();
    this.dirty = true;
  }

  /** Pans by a screen-space delta — the direct response to a drag. */
  panByScreen(dxScreen: number, dyScreen: number): void {
    this.targetX -= dxScreen / this.zoom;
    this.targetY -= dyScreen / this.zoom;
    // A drag is a direct manipulation: snap rather than ease, or the map feels
    // like it is lagging behind the cursor.
    this.x = this.targetX;
    this.y = this.targetY;
    this.constrain();
    this.dirty = true;
  }

  /** Centres on a world point, easing there over subsequent frames. */
  panTo(worldX: number, worldY: number, immediate = false): void {
    this.targetX = worldX;
    this.targetY = worldY;
    if (immediate) {
      this.x = worldX;
      this.y = worldY;
    }
    this.velocityX = 0;
    this.velocityY = 0;
    this.constrain();
    this.dirty = true;
  }

  /** Imparts coasting velocity, in world units per second. */
  setVelocity(vx: number, vy: number): void {
    this.velocityX = vx;
    this.velocityY = vy;
  }

  /**
   * Zooms about a fixed screen point.
   *
   * Anchoring on the cursor rather than the viewport centre is what makes wheel
   * zoom feel correct: the world point under the pointer stays under the
   * pointer. Centre-anchored zoom forces a corrective pan after every scroll
   * and is the single most common way this feature is got wrong.
   */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);

    this.targetZoom = clamp(this.targetZoom * factor, this.minZoom, this.maxZoom);
    // Apply immediately so the anchor maths below uses the final zoom; easing
    // the zoom itself would drift the anchor point during the transition.
    this.zoom = this.targetZoom;

    const after = this.screenToWorld(screenX, screenY);

    this.targetX += before.x - after.x;
    this.targetY += before.y - after.y;
    this.x = this.targetX;
    this.y = this.targetY;

    this.constrain();
    this.dirty = true;
  }

  /**
   * Advances smoothing and inertia.
   *
   * `damp` is frame-rate independent: the same gesture decays identically at 30
   * and 144 fps. A naive `velocity *= 0.9` per frame would make the map coast
   * more than four times further on a high-refresh display.
   */
  update(deltaSeconds: number): boolean {
    const wasDirty = this.dirty;
    this.dirty = false;

    const speedSq = this.velocityX * this.velocityX + this.velocityY * this.velocityY;
    if (speedSq > 0.01) {
      const retained = Math.pow(this.friction, deltaSeconds);

      /**
       * Displacement is integrated analytically rather than as `v * dt`.
       *
       * Velocity decays as `v₀·fᵗ`, so the exact distance covered over `dt` is
       * `∫₀^dt v₀·fᵗ dt = v₀·(f^dt − 1) / ln f`. Using Euler steps instead makes
       * position frame-rate dependent even though the decay itself is not: a
       * single 1 s frame coasted ~600 units where ten 100 ms frames coasted
       * ~113. This closed form makes the two agree to float precision.
       */
      const displacement =
        this.friction >= 1 ? deltaSeconds : (retained - 1) / Math.log(this.friction);

      this.targetX += this.velocityX * displacement;
      this.targetY += this.velocityY * displacement;

      this.velocityX *= retained;
      this.velocityY *= retained;

      this.constrain();
      this.dirty = true;
    } else if (speedSq !== 0) {
      // Below the threshold, stop dead rather than easing toward zero forever
      // and marking the camera dirty on every frame of an idle session.
      this.velocityX = 0;
      this.velocityY = 0;
    }

    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      this.x = damp(this.x, this.targetX, this.smoothing, deltaSeconds);
      this.y = damp(this.y, this.targetY, this.smoothing, deltaSeconds);
      this.dirty = true;
    } else if (dx !== 0 || dy !== 0) {
      this.x = this.targetX;
      this.y = this.targetY;
      this.dirty = true;
    }

    return wasDirty || this.dirty;
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.viewportWidth / 2) / this.zoom + this.x,
      y: (screenY - this.viewportHeight / 2) / this.zoom + this.y,
    };
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: (worldX - this.x) * this.zoom + this.viewportWidth / 2,
      y: (worldY - this.y) * this.zoom + this.viewportHeight / 2,
    };
  }

  /** Visible world rectangle, used for culling. */
  getViewBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfWidth = this.viewportWidth / 2 / this.zoom;
    const halfHeight = this.viewportHeight / 2 / this.zoom;
    return {
      minX: this.x - halfWidth,
      minY: this.y - halfHeight,
      maxX: this.x + halfWidth,
      maxY: this.y + halfHeight,
    };
  }

  get scale(): number {
    return this.zoom;
  }

  get viewport(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Keeps the viewport inside the world.
   *
   * Clamps the *centre* so the visible rectangle never leaves the map. When the
   * world is narrower than the viewport on an axis (possible mid-resize before
   * `minZoom` is recomputed) the camera locks to the centre of that axis rather
   * than producing an inverted clamp range.
   */
  private constrain(): void {
    const halfWidth = this.viewportWidth / 2 / this.zoom;
    const halfHeight = this.viewportHeight / 2 / this.zoom;

    if (halfWidth * 2 >= this.bounds.width) {
      this.targetX = this.bounds.width / 2;
      this.x = this.targetX;
      this.velocityX = 0;
    } else {
      const clamped = clamp(this.targetX, halfWidth, this.bounds.width - halfWidth);
      if (clamped !== this.targetX) this.velocityX = 0;
      this.targetX = clamped;
      this.x = clamp(this.x, halfWidth, this.bounds.width - halfWidth);
    }

    if (halfHeight * 2 >= this.bounds.height) {
      this.targetY = this.bounds.height / 2;
      this.y = this.targetY;
      this.velocityY = 0;
    } else {
      const clamped = clamp(this.targetY, halfHeight, this.bounds.height - halfHeight);
      if (clamped !== this.targetY) this.velocityY = 0;
      this.targetY = clamped;
      this.y = clamp(this.y, halfHeight, this.bounds.height - halfHeight);
    }
  }
}
