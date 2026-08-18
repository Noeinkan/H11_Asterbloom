import { describe, expect, it } from 'vitest';
import { GradientCache, stopsSig, type ColorStop } from '../../src/game/render/starfield';

/**
 * These tests drive the real `GradientCache`, not a stand-in. Constructing a
 * `FillGradient` is cheap and DOM-free — Pixi only rasterizes the ramp onto a
 * canvas later, inside `buildGradient()`, which the renderer calls. So the
 * cache's identity / invalidation contract is fully testable in node.
 *
 * That contract exists because of a sharp edge in Pixi: `buildGradient()`
 * short-circuits on `if (this.texture) return`. Once a gradient has been
 * rasterized, writing to `colorStops` or `center` is silently ignored. The
 * cache must therefore hand back a *new* instance whenever the colors or the
 * drift move, or the backdrop freezes at whatever palette it first painted.
 */

const RED: ColorStop[] = [
  { offset: 0, color: 0xff0000 },
  { offset: 1, color: 0x000000 },
];
const BLUE: ColorStop[] = [
  { offset: 0, color: 0x0000ff },
  { offset: 1, color: 0x000000 },
];

describe('stopsSig', () => {
  it('is stable for equal stops', () => {
    expect(stopsSig(RED)).toBe(stopsSig([...RED.map((s) => ({ ...s }))]));
  });

  it('differs when a color changes', () => {
    expect(stopsSig(RED)).not.toBe(stopsSig(BLUE));
  });

  it('differs when an offset changes', () => {
    const moved: ColorStop[] = [
      { offset: 0, color: 0xff0000 },
      { offset: 0.5, color: 0x000000 },
    ];
    expect(stopsSig(RED)).not.toBe(stopsSig(moved));
  });
});

describe('GradientCache', () => {
  it('reuses the instance while the stops are unchanged', () => {
    const cache = new GradientCache();
    const a = cache.linear('band', RED);
    const b = cache.linear('band', RED);
    expect(a).toBe(b);
    cache.destroy();
  });

  it('rebuilds when the stops change, because a built texture is immutable', () => {
    const cache = new GradientCache();
    const a = cache.linear('band', RED);
    const b = cache.linear('band', BLUE);
    expect(b).not.toBe(a);
    cache.destroy();
  });

  it('keeps distinct keys on distinct instances', () => {
    const cache = new GradientCache();
    const a = cache.radial('bloom', RED);
    const b = cache.radial('halo', RED);
    expect(a).not.toBe(b);
    cache.destroy();
  });

  it('reuses a radial while neither stops nor drift move', () => {
    const cache = new GradientCache();
    const a = cache.radial('bloom', RED, true);
    const b = cache.radial('bloom', RED, true);
    expect(a).toBe(b);
    cache.destroy();
  });

  it('rebuilds a driftable radial once the breath offset moves', () => {
    const cache = new GradientCache();
    const a = cache.radial('bloom', RED, true);
    expect(cache.setDrift(0.02, -0.01)).toBe(true);
    const b = cache.radial('bloom', RED, true);
    expect(b).not.toBe(a);
    expect(b.center).toEqual({ x: 0.52, y: 0.49 });
    cache.destroy();
  });

  it('leaves non-driftable radials anchored when the breath moves', () => {
    const cache = new GradientCache();
    const a = cache.radial('band', RED, false);
    cache.setDrift(0.02, -0.01);
    const b = cache.radial('band', RED, false);
    expect(b).toBe(a);
    expect(b.center).toEqual({ x: 0.5, y: 0.5 });
    cache.destroy();
  });

  it('setDrift reports no change for a repeated offset, so no repaint is queued', () => {
    const cache = new GradientCache();
    expect(cache.setDrift(0.02, 0)).toBe(true);
    expect(cache.setDrift(0.02, 0)).toBe(false);
    cache.destroy();
  });

  it('destroy() releases every cached gradient and starts fresh', () => {
    const cache = new GradientCache();
    const a = cache.linear('band', RED);
    cache.destroy();
    const b = cache.linear('band', RED);
    expect(b).not.toBe(a);
    cache.destroy();
  });
});
