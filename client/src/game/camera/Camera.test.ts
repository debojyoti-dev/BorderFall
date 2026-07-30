import { beforeEach, describe, expect, it } from 'vitest';
import { Camera } from './Camera.js';

describe('Camera', () => {
  let camera: Camera;

  beforeEach(() => {
    camera = new Camera({ width: 8192, height: 8192 }, { maxZoom: 8 });
    camera.resize(1000, 800);
  });

  it('round-trips screen and world coordinates', () => {
    camera.panTo(3000, 4000, true);
    const world = camera.screenToWorld(250, 600);
    const screen = camera.worldToScreen(world.x, world.y);
    expect(screen.x).toBeCloseTo(250, 6);
    expect(screen.y).toBeCloseTo(600, 6);
  });

  it('maps the viewport centre to the camera position', () => {
    camera.panTo(1234, 5678, true);
    const world = camera.screenToWorld(500, 400);
    expect(world.x).toBeCloseTo(1234, 6);
    expect(world.y).toBeCloseTo(5678, 6);
  });

  it('keeps the anchor point fixed while zooming', () => {
    // The property that makes wheel zoom feel right: the world point under the
    // cursor must not move. Centre-anchored zoom fails this.
    camera.panTo(4000, 4000, true);
    const anchorScreen = { x: 800, y: 200 };
    const before = camera.screenToWorld(anchorScreen.x, anchorScreen.y);

    camera.zoomAt(anchorScreen.x, anchorScreen.y, 1.5);

    const after = camera.screenToWorld(anchorScreen.x, anchorScreen.y);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });

  it('holds the anchor across repeated zoom steps', () => {
    camera.panTo(4000, 4000, true);
    const before = camera.screenToWorld(300, 300);
    for (let i = 0; i < 10; i++) camera.zoomAt(300, 300, 1.1);
    const after = camera.screenToWorld(300, 300);
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
  });

  it('clamps zoom to its configured range', () => {
    for (let i = 0; i < 100; i++) camera.zoomAt(500, 400, 2);
    expect(camera.zoom).toBeLessThanOrEqual(8);

    for (let i = 0; i < 100; i++) camera.zoomAt(500, 400, 0.5);
    // Cannot zoom out past the point where the world fills the viewport.
    expect(camera.zoom).toBeGreaterThanOrEqual(1000 / 8192);
  });

  it('never lets the viewport leave the world', () => {
    camera.zoomAt(500, 400, 4);
    camera.panTo(-100_000, -100_000, true);

    const view = camera.getViewBounds();
    expect(view.minX).toBeGreaterThanOrEqual(-0.01);
    expect(view.minY).toBeGreaterThanOrEqual(-0.01);

    camera.panTo(100_000, 100_000, true);
    const far = camera.getViewBounds();
    expect(far.maxX).toBeLessThanOrEqual(8192.01);
    expect(far.maxY).toBeLessThanOrEqual(8192.01);
  });

  it('centres an axis when the world is not larger than the viewport', () => {
    // At minimum zoom the world exactly fills the viewport; the camera must
    // lock to the centre rather than produce an inverted clamp range.
    camera.fitToWorld();
    expect(camera.x).toBeCloseTo(4096, 6);
    expect(camera.y).toBeCloseTo(4096, 6);
  });

  it('decays inertia frame-rate independently', () => {
    // The whole point of exponential damping: one long frame must produce the
    // same result as several short ones summing to the same duration.
    const single = new Camera({ width: 8192, height: 8192 });
    single.resize(1000, 800);
    single.zoomAt(500, 400, 4);
    single.panTo(4000, 4000, true);
    single.setVelocity(600, 0);
    single.update(1);

    const stepped = new Camera({ width: 8192, height: 8192 });
    stepped.resize(1000, 800);
    stepped.zoomAt(500, 400, 4);
    stepped.panTo(4000, 4000, true);
    stepped.setVelocity(600, 0);
    for (let i = 0; i < 10; i++) stepped.update(0.1);

    // Euler stepping diverged by ~487 world units; analytic integration of the
    // velocity brings this under 0.05. The small residual is inherent rather
    // than a bug: position also eases toward a target that is itself moving,
    // so the easing stage samples a moving target at different rates. 0.05 of
    // 8192 world units is sub-pixel at any zoom level.
    expect(Math.abs(stepped.x - single.x)).toBeLessThan(0.05);
  });

  it('comes to a complete stop rather than coasting forever', () => {
    camera.zoomAt(500, 400, 4);
    camera.panTo(4000, 4000, true);
    camera.setVelocity(500, 500);

    for (let i = 0; i < 300; i++) camera.update(1 / 60);

    // Once settled, further updates must report "not dirty" so the renderer
    // can skip idle frames instead of redrawing forever.
    camera.update(1 / 60);
    expect(camera.update(1 / 60)).toBe(false);
  });

  it('reports dirty after a transform change and clean when idle', () => {
    camera.update(1 / 60);
    expect(camera.update(1 / 60)).toBe(false);

    camera.panByScreen(10, 10);
    expect(camera.update(1 / 60)).toBe(true);
  });

  it('converts a screen drag into the correct world displacement', () => {
    camera.zoomAt(500, 400, 4);
    const zoom = camera.zoom;
    const startX = camera.x;

    camera.panByScreen(100, 0);
    // Dragging content right by 100px moves the camera left by 100/zoom.
    expect(camera.x).toBeCloseTo(startX - 100 / zoom, 4);
  });

  it('produces view bounds matching the zoom level', () => {
    camera.panTo(4096, 4096, true);
    camera.zoomAt(500, 400, 2);
    const view = camera.getViewBounds();
    expect(view.maxX - view.minX).toBeCloseTo(1000 / camera.zoom, 4);
    expect(view.maxY - view.minY).toBeCloseTo(800 / camera.zoom, 4);
  });

  it('raises minimum zoom when the viewport grows', () => {
    camera.fitToWorld();
    const smallZoom = camera.zoom;
    camera.resize(4000, 3000);
    expect(camera.zoom).toBeGreaterThan(smallZoom);
  });
});
