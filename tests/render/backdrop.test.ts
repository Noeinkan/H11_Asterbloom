import { describe, expect, it } from 'vitest';
import {
  GradientCache,
  bandStops,
  bloomStops,
  stopsSig,
  type ColorStop,
} from '../../src/game/render/starfield';

/**
 * The backdrop's blooms are *shapes* — a circle or an ellipse — drawn at
 * partial alpha over layers that have already painted the same pixels. A
 * bloom that ends on an opaque color therefore composites as a hard step
 * along its own outline, which is what showed up in the void theme as a
 * stray ellipse hanging in the sky.
 *
 * The invariant that fixes it, and that these tests pin, is: every bloom
 * gradient reaches alpha 0 at its rim. Then the rim is a no-op against
 * whatever is underneath, whatever that happens to be, and a bloom smaller
 * than the viewport can no longer outline itself.
 *
 * Rasterizing a gradient needs a canvas, so the ramp itself is not exercised
 * here — only the stops handed to Pixi, which is where the bug lived.
 */

const last = (stops: ColorStop[]): ColorStop => stops[stops.length - 1]!;

describe('bloomStops', () => {
  it('ends fully transparent, so the shape draws no rim', () => {
    expect(last(bloomStops(0xffffff, 0x102030)).alpha).toBe(0);
  });

  it('fades out on the edge color, so the tail shifts alpha and not hue', () => {
    const stops = bloomStops(0xffffff, 0x102030);
    const tail = stops.slice(-2);
    expect(tail.map((s) => s.color)).toEqual([0x102030, 0x102030]);
    expect(tail[0]!.alpha ?? 1).toBe(1);
  });

  it('holds the peak across the plateau before falling off', () => {
    const stops = bloomStops(0xffffff, 0x000000, 0.34);
    expect(stops[0]).toEqual({ offset: 0, color: 0xffffff });
    expect(stops[1]).toEqual({ offset: 0.34, color: 0xffffff });
  });

  it('keeps offsets ascending inside [0, 1]', () => {
    const stops = bloomStops(0xffffff, 0x000000);
    expect(stops[0]!.offset).toBe(0);
    expect(last(stops).offset).toBe(1);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]!.offset).toBeGreaterThan(stops[i - 1]!.offset);
    }
  });
});

describe('bandStops', () => {
  it('feathers to nothing at both ends of the gradient axis', () => {
    const stops = bandStops(0xffffff, 0x102030);
    expect(stops[0]!.alpha).toBe(0);
    expect(last(stops).alpha).toBe(0);
  });

  it('peaks in the middle, so the band still reads as a highlight', () => {
    const stops = bandStops(0xffffff, 0x102030);
    const peaks = stops.filter((s) => s.color === 0xffffff);
    expect(peaks).toHaveLength(2);
    expect(peaks.every((s) => s.offset > 0.2 && s.offset < 0.8)).toBe(true);
  });
});

describe('stopsSig with alpha', () => {
  it('separates stops that differ only in alpha', () => {
    const opaque: ColorStop[] = [{ offset: 1, color: 0x102030 }];
    const clear: ColorStop[] = [{ offset: 1, color: 0x102030, alpha: 0 }];
    expect(stopsSig(opaque)).not.toBe(stopsSig(clear));
  });

  it('treats an omitted alpha as 1', () => {
    expect(stopsSig([{ offset: 0, color: 0x102030 }])).toBe(
      stopsSig([{ offset: 0, color: 0x102030, alpha: 1 }]),
    );
  });
});

describe('GradientCache alpha stops', () => {
  it('hands Pixi #rrggbbaa for a translucent stop', () => {
    const cache = new GradientCache();
    const grad = cache.radial('bloom', bloomStops(0xffffff, 0x102030));
    expect(grad.colorStops[grad.colorStops.length - 1]!.color).toBe('#10203000');
    cache.destroy();
  });

  it('leaves opaque stops as plain #rrggbb', () => {
    const cache = new GradientCache();
    const grad = cache.linear('band', [{ offset: 0, color: 0x0a0b0c }]);
    expect(grad.colorStops[0]!.color).toBe('#0a0b0c');
    cache.destroy();
  });

  it('rebuilds when only a stop alpha moves, since a built ramp is immutable', () => {
    const cache = new GradientCache();
    const a = cache.radial('bloom', [{ offset: 1, color: 0x102030, alpha: 0 }]);
    const b = cache.radial('bloom', [{ offset: 1, color: 0x102030, alpha: 0.5 }]);
    expect(b).not.toBe(a);
    cache.destroy();
  });
});
