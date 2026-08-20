import { describe, expect, it } from 'vitest';
import {
  fitTransform,
  mapPoint,
  unmapPoint,
  viewRectOn,
  viewWorldRect,
  worldBounds,
  type WorldBounds,
} from '../../src/game/render/minimapGeom';
import { inView, type ViewBox } from '../../src/game/render/viewport';
import type { Asteroid } from '../../src/game/sim/types';

/**
 * The minimap's whole job is to agree with what the camera is actually
 * showing. Two transforms have to stay in step for that: the world→minimap
 * fit, and `viewport.ts`'s world→screen. If they drift, the view rectangle
 * lies about where the player is looking, which is worse than no minimap.
 */

function rock(x: number, y: number, radius = 100): Asteroid {
  return { x, y, radius } as Asteroid;
}

const BOX = { w: 160, h: 120, pad: 6 };

describe('worldBounds', () => {
  it('returns null for an empty field', () => {
    expect(worldBounds([])).toBeNull();
  });

  it('includes rock radii, not just centres', () => {
    const b = worldBounds([rock(0, 0, 50)])!;
    expect(b).toEqual({ minX: -50, minY: -50, maxX: 50, maxY: 50 });
  });

  it('spans every rock', () => {
    const b = worldBounds([rock(-200, 0, 10), rock(300, 80, 20)])!;
    expect(b.minX).toBe(-210);
    expect(b.maxX).toBe(320);
    expect(b.minY).toBe(-10);
    expect(b.maxY).toBe(100);
  });
});

describe('fitTransform', () => {
  const bounds = (minX: number, minY: number, maxX: number, maxY: number) =>
    ({ minX, minY, maxX, maxY }) as WorldBounds;

  it('scales both axes by the same factor, so the map never skews', () => {
    const t = fitTransform(bounds(0, 0, 1000, 200), BOX.w, BOX.h, BOX.pad);
    const a = mapPoint(t, 0, 0);
    const b = mapPoint(t, 100, 100);
    // Equal world deltas must give equal minimap deltas on both axes.
    expect(b.x - a.x).toBeCloseTo(b.y - a.y, 9);
  });

  it('fits inside the padded box on the constraining axis', () => {
    const t = fitTransform(bounds(0, 0, 1000, 200), BOX.w, BOX.h, BOX.pad);
    const tl = mapPoint(t, 0, 0);
    const br = mapPoint(t, 1000, 200);
    expect(tl.x).toBeGreaterThanOrEqual(BOX.pad - 1e-9);
    expect(br.x).toBeLessThanOrEqual(BOX.w - BOX.pad + 1e-9);
    expect(tl.y).toBeGreaterThanOrEqual(BOX.pad - 1e-9);
    expect(br.y).toBeLessThanOrEqual(BOX.h - BOX.pad + 1e-9);
  });

  it('letterboxes a wide map — equal slack above and below', () => {
    const t = fitTransform(bounds(0, 0, 1000, 200), BOX.w, BOX.h, BOX.pad);
    const top = mapPoint(t, 0, 0).y;
    const bottom = mapPoint(t, 0, 200).y;
    expect(top - BOX.pad).toBeCloseTo(BOX.h - BOX.pad - bottom, 9);
  });

  it('pillarboxes a tall map — equal slack left and right', () => {
    const t = fitTransform(bounds(0, 0, 200, 1000), BOX.w, BOX.h, BOX.pad);
    const left = mapPoint(t, 0, 0).x;
    const right = mapPoint(t, 200, 0).x;
    expect(left - BOX.pad).toBeCloseTo(BOX.w - BOX.pad - right, 9);
  });

  it('stays finite for a single rock, where the span is zero', () => {
    const b = worldBounds([rock(500, 500, 0)])!;
    const t = fitTransform(b, BOX.w, BOX.h, BOX.pad);
    const p = mapPoint(t, 500, 500);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it('survives a box smaller than its own padding', () => {
    const t = fitTransform(bounds(0, 0, 100, 100), 4, 4, 6);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(mapPoint(t, 50, 50).x)).toBe(true);
  });
});

describe('mapPoint / unmapPoint', () => {
  it('round-trips world coordinates', () => {
    const b = worldBounds([rock(-400, -120), rock(900, 640)])!;
    const t = fitTransform(b, BOX.w, BOX.h, BOX.pad);
    for (const [x, y] of [
      [0, 0],
      [-400, -120],
      [900, 640],
      [123.5, -77.25],
    ] as const) {
      const p = mapPoint(t, x, y);
      const back = unmapPoint(t, p.x, p.y);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it('maps a click in the middle of the widget to the middle of the map', () => {
    const b = worldBounds([rock(0, 0, 100), rock(600, 400, 100)])!;
    const t = fitTransform(b, BOX.w, BOX.h, BOX.pad);
    const centre = unmapPoint(t, BOX.w / 2, BOX.h / 2);
    expect(centre.x).toBeCloseTo((b.minX + b.maxX) / 2, 6);
    expect(centre.y).toBeCloseTo((b.minY + b.maxY) / 2, 6);
  });
});

describe('view rectangle', () => {
  const view = (over: Partial<ViewBox> = {}): ViewBox => ({
    camX: 0,
    camY: 0,
    zoom: 1,
    w: 800,
    h: 600,
    ...over,
  });

  it('inverts the viewport transform', () => {
    // viewport.ts: sx = x * zoom + camX. At sx = 0 the world x is -camX/zoom.
    const v = view({ camX: -320, camY: -240, zoom: 2 });
    const r = viewWorldRect(v);
    expect(r.x).toBeCloseTo(160, 9);
    expect(r.y).toBeCloseTo(120, 9);
    expect(r.w).toBeCloseTo(400, 9);
    expect(r.h).toBeCloseTo(300, 9);
  });

  it('grows as the camera zooms out', () => {
    const wide = viewWorldRect(view({ zoom: 0.5 }));
    const tight = viewWorldRect(view({ zoom: 4 }));
    expect(wide.w).toBeGreaterThan(tight.w);
  });

  it('agrees with viewport.inView about what is on screen', () => {
    // The load-bearing check: a rock the minimap draws inside the view rect
    // must be a rock `inView` also considers visible, for the same ViewBox.
    const rocks = [
      rock(0, 0, 40),
      rock(700, 200, 40),
      rock(-900, -700, 40),
      rock(1800, 1500, 40),
    ];
    const b = worldBounds(rocks)!;
    const t = fitTransform(b, BOX.w, BOX.h, BOX.pad);
    const v = view({ camX: 100, camY: 80, zoom: 0.75 });
    const rect = viewRectOn(t, v);

    for (const a of rocks) {
      const p = mapPoint(t, a.x, a.y);
      const insideRect =
        p.x >= rect.x &&
        p.x <= rect.x + rect.w &&
        p.y >= rect.y &&
        p.y <= rect.y + rect.h;
      // `inView` pads by the rock radius; compare centres with no padding so
      // the two agree on the strict question "is this centre on screen".
      const onScreen = inView(a.x, a.y, 0, v, 0);
      expect(insideRect).toBe(onScreen);
    }
  });

  it('covers the whole minimap once the camera holds the entire map', () => {
    const rocks = [rock(0, 0, 100), rock(1200, 800, 100)];
    const b = worldBounds(rocks)!;
    const t = fitTransform(b, BOX.w, BOX.h, BOX.pad);
    // Zoomed far out and centred: the rect should contain every rock.
    const v: ViewBox = { camX: 400, camY: 300, zoom: 0.05, w: 800, h: 600 };
    const rect = viewRectOn(t, v);
    for (const a of rocks) {
      const p = mapPoint(t, a.x, a.y);
      expect(p.x).toBeGreaterThanOrEqual(rect.x);
      expect(p.x).toBeLessThanOrEqual(rect.x + rect.w);
      expect(p.y).toBeGreaterThanOrEqual(rect.y);
      expect(p.y).toBeLessThanOrEqual(rect.y + rect.h);
    }
  });

  it('stays finite at zero zoom', () => {
    const r = viewWorldRect(view({ zoom: 0 }));
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.w)).toBe(true);
  });
});
