import type { WorldReader } from '@borderfall/shared';
import type { Camera } from '../camera/Camera.js';

/**
 * Translates raw pointer and wheel events into camera and selection intent.
 *
 * Uses Pointer Events rather than separate mouse and touch handlers: one code
 * path covers mouse, trackpad, pen and touch, and pointer capture makes a drag
 * that leaves the canvas behave correctly instead of sticking.
 */

export interface PointerCallbacks {
  onHover(territoryId: number): void;
  onSelect(territoryId: number): void;
  onContext(territoryId: number): void;
}

/** Pixels of movement before a press is treated as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

/** Window over which pointer movement is averaged to derive throw velocity. */
const VELOCITY_WINDOW_MS = 90;

export class PointerController {
  private dragging = false;
  private pointerDown = false;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private activePointerId: number | null = null;

  /** Recent samples for velocity estimation on release. */
  private readonly samples: Array<{ x: number; y: number; time: number }> = [];

  /** Live pointers, for pinch-zoom on touch devices. */
  private readonly activePointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;

  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly world: WorldReader,
    private readonly callbacks: PointerCallbacks,
  ) {
    this.attach();
  }

  private attach(): void {
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler as EventListener, options);
      this.disposers.push(() =>
        target.removeEventListener(type, handler as EventListener, options),
      );
    };

    listen(this.canvas, 'pointerdown', this.onPointerDown);
    listen(this.canvas, 'pointermove', this.onPointerMove);
    listen(this.canvas, 'pointerup', this.onPointerUp);
    listen(this.canvas, 'pointercancel', this.onPointerUp);
    listen(this.canvas, 'pointerleave', this.onPointerLeave);
    // `passive: false` because we must preventDefault to stop the page zooming.
    listen(this.canvas, 'wheel', this.onWheel, { passive: false });
    listen(this.canvas, 'contextmenu', this.onContextMenu);
  }

  private toLocal(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown = (event: PointerEvent): void => {
    const local = this.toLocal(event);
    this.activePointers.set(event.pointerId, local);

    if (this.activePointers.size === 2) {
      this.pinchDistance = this.currentPinchDistance();
      this.dragging = false;
      return;
    }

    if (this.activePointers.size > 2) return;

    this.activePointerId = event.pointerId;
    this.pointerDown = true;
    this.dragging = false;
    this.downX = local.x;
    this.downY = local.y;
    this.lastX = local.x;
    this.lastY = local.y;

    this.samples.length = 0;
    this.samples.push({ x: local.x, y: local.y, time: performance.now() });

    // Halt any coast in progress, so grabbing the map stops it dead.
    this.camera.setVelocity(0, 0);

    // Capture keeps delivering events if the pointer leaves the canvas, so a
    // fast drag does not get stuck mid-gesture.
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const local = this.toLocal(event);

    if (this.activePointers.has(event.pointerId)) {
      this.activePointers.set(event.pointerId, local);
    }

    if (this.activePointers.size === 2) {
      this.handlePinch(local);
      return;
    }

    if (!this.pointerDown || event.pointerId !== this.activePointerId) {
      // Not dragging: report hover.
      const world = this.camera.screenToWorld(local.x, local.y);
      this.callbacks.onHover(this.world.pick(world.x, world.y));
      return;
    }

    const totalDx = local.x - this.downX;
    const totalDy = local.y - this.downY;
    if (!this.dragging && Math.hypot(totalDx, totalDy) > DRAG_THRESHOLD_PX) {
      this.dragging = true;
    }

    if (this.dragging) {
      this.camera.panByScreen(local.x - this.lastX, local.y - this.lastY);
      this.recordSample(local.x, local.y);
    }

    this.lastX = local.x;
    this.lastY = local.y;
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.activePointers.size < 2) this.pinchDistance = 0;

    if (event.pointerId !== this.activePointerId) return;

    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (this.dragging) {
      this.applyThrowVelocity();
    } else if (this.pointerDown) {
      // Movement stayed under the threshold: treat as a click, not a drag.
      const local = this.toLocal(event);
      const world = this.camera.screenToWorld(local.x, local.y);
      const picked = this.world.pick(world.x, world.y);
      if (event.button === 2) {
        this.callbacks.onContext(picked);
      } else {
        this.callbacks.onSelect(picked);
      }
    }

    this.pointerDown = false;
    this.dragging = false;
    this.activePointerId = null;
    this.samples.length = 0;
  };

  private onPointerLeave = (): void => {
    if (!this.pointerDown) this.callbacks.onHover(-1);
  };

  private onWheel = (event: WheelEvent): void => {
    // Without this the browser zooms the whole page on ctrl+wheel and
    // rubber-band scrolls on trackpads.
    event.preventDefault();

    const local = this.toLocal(event);

    /**
     * Normalise across the three `deltaMode` values browsers actually emit.
     * Firefox reports lines, not pixels, so a raw `deltaY` makes wheel zoom
     * roughly 30× weaker there than in Chrome.
     */
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    const delta = event.deltaY * scale;

    // Exponential mapping keeps each notch a constant *proportional* change,
    // so zooming feels the same at every magnification.
    const factor = Math.exp(-delta * 0.0015);
    this.camera.zoomAt(local.x, local.y, factor);
  };

  private onContextMenu = (event: Event): void => {
    // Right-drag pans and right-click issues orders; the native menu would
    // interrupt both.
    event.preventDefault();
  };

  private handlePinch(local: { x: number; y: number }): void {
    const distance = this.currentPinchDistance();
    if (this.pinchDistance > 0 && distance > 0) {
      const centre = this.pinchCentre();
      this.camera.zoomAt(centre.x, centre.y, distance / this.pinchDistance);
    }
    this.pinchDistance = distance;
    this.lastX = local.x;
    this.lastY = local.y;
  }

  private currentPinchDistance(): number {
    const points = [...this.activePointers.values()];
    if (points.length < 2) return 0;
    const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private pinchCentre(): { x: number; y: number } {
    const points = [...this.activePointers.values()];
    if (points.length < 2) return { x: this.lastX, y: this.lastY };
    const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private recordSample(x: number, y: number): void {
    const now = performance.now();
    this.samples.push({ x, y, time: now });
    while (
      this.samples.length > 1 &&
      now - (this.samples[0] as { time: number }).time > VELOCITY_WINDOW_MS
    ) {
      this.samples.shift();
    }
  }

  /**
   * Converts recent pointer movement into coasting velocity.
   *
   * Averaged over a short window rather than taken from the final two events:
   * the last sample before release is frequently near-stationary (the finger
   * settles before lifting), and using it alone kills the throw entirely.
   */
  private applyThrowVelocity(): void {
    if (this.samples.length < 2) return;

    const first = this.samples[0] as { x: number; y: number; time: number };
    const last = this.samples[this.samples.length - 1] as { x: number; y: number; time: number };
    const elapsed = (last.time - first.time) / 1000;
    if (elapsed <= 0.001) return;

    // Screen-space velocity, inverted because dragging content right moves the
    // camera left, then converted to world units.
    const vx = -((last.x - first.x) / elapsed) / this.camera.scale;
    const vy = -((last.y - first.y) / elapsed) / this.camera.scale;

    this.camera.setVelocity(vx, vy);
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.activePointers.clear();
  }
}
