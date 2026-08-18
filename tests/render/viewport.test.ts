import { describe, expect, it } from 'vitest';
import { inView, type ViewBox } from '../../src/game/render/viewport';

const VIEW: ViewBox = { camX: 0, camY: 0, zoom: 1, w: 100, h: 100 };

describe('inView', () => {
  it('accepts a point inside the viewport', () => {
    expect(inView(50, 50, 0, VIEW, 0)).toBe(true);
  });

  it('rejects a point past each edge', () => {
    expect(inView(-1, 50, 0, VIEW, 0)).toBe(false);
    expect(inView(101, 50, 0, VIEW, 0)).toBe(false);
    expect(inView(50, -1, 0, VIEW, 0)).toBe(false);
    expect(inView(50, 101, 0, VIEW, 0)).toBe(false);
  });

  it('treats the exact edge as outside', () => {
    expect(inView(0, 50, 0, VIEW, 0)).toBe(false);
    expect(inView(100, 50, 0, VIEW, 0)).toBe(false);
  });

  it('pulls something just outside back in via the pad', () => {
    expect(inView(-5, 50, 0, VIEW, 0)).toBe(false);
    expect(inView(-5, 50, 0, VIEW, 10)).toBe(true);
  });

  it('counts the radius the same way as the pad', () => {
    expect(inView(-5, 50, 10, VIEW, 0)).toBe(true);
  });

  it('scales world coordinates by zoom, so zooming in culls more', () => {
    expect(inView(60, 50, 0, VIEW, 0)).toBe(true);
    expect(inView(60, 50, 0, { ...VIEW, zoom: 2 }, 0)).toBe(false);
  });

  it('offsets by the camera', () => {
    expect(inView(-50, 50, 0, VIEW, 0)).toBe(false);
    expect(inView(-50, 50, 0, { ...VIEW, camX: 80 }, 0)).toBe(true);
  });

  it('scales the pad by zoom too, so a padded margin holds when zoomed out', () => {
    // At zoom 0.5 the point sits at sx = -5; a pad of 10 world units is only
    // 5 screen px, which is exactly the edge and therefore still outside.
    expect(inView(-10, 100, 0, { ...VIEW, zoom: 0.5 }, 10)).toBe(false);
    expect(inView(-10, 100, 0, { ...VIEW, zoom: 0.5 }, 11)).toBe(true);
  });
});
