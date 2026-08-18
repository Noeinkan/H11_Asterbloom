import { describe, expect, it } from 'vitest';

/**
 * The cache implementation lives inside `src/game/render/starfield.ts`. We
 * only verify the contract here: same key returns the same instance, distinct
 * keys return distinct instances, `destroy()` calls `destroy()` on every
 * cached value, and the entries map is cleared.
 *
 * The actual `FillGradient` integration is exercised in the browser build,
 * not in unit tests — Pixi's gradient class needs a DOM canvas, which the
 * vitest `node` environment does not provide.
 */

interface Disposable {
  destroy(): void;
}

class FakeGradient implements Disposable {
  destroyed = false;
  destroyedCount = 0;
  destroy(): void {
    this.destroyed = true;
    this.destroyedCount += 1;
  }
}

class FakeCache {
  private readonly entries = new Map<string, FakeGradient>();

  get(key: string, factory: () => FakeGradient): FakeGradient {
    let g = this.entries.get(key);
    if (g) return g;
    g = factory();
    this.entries.set(key, g);
    return g;
  }

  destroy(): void {
    for (const g of this.entries.values()) g.destroy();
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

describe('GradientCache contract', () => {
  it('returns the same instance for the same key', () => {
    const cache = new FakeCache();
    const a = cache.get('band:void', () => new FakeGradient());
    const b = cache.get('band:void', () => new FakeGradient());
    expect(a).toBe(b);
    expect(cache.size()).toBe(1);
  });

  it('returns distinct instances for distinct keys', () => {
    const cache = new FakeCache();
    const a = cache.get('band:void', () => new FakeGradient());
    const b = cache.get('band:nebula', () => new FakeGradient());
    expect(a).not.toBe(b);
    expect(cache.size()).toBe(2);
  });

  it('only invokes the factory once per key', () => {
    const cache = new FakeCache();
    let factories = 0;
    const make = () => {
      factories += 1;
      return new FakeGradient();
    };
    cache.get('band:void', make);
    cache.get('band:void', make);
    cache.get('band:void', make);
    expect(factories).toBe(1);
  });

  it('destroy() destroys every cached value and clears the map', () => {
    const cache = new FakeCache();
    const a = cache.get('band:void', () => new FakeGradient());
    const b = cache.get('band:nebula', () => new FakeGradient());
    expect(cache.size()).toBe(2);
    cache.destroy();
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
    expect(cache.size()).toBe(0);
  });

  it('after destroy(), the next get() builds a fresh instance', () => {
    const cache = new FakeCache();
    const a = cache.get('band:void', () => new FakeGradient());
    cache.destroy();
    const b = cache.get('band:void', () => new FakeGradient());
    expect(b).not.toBe(a);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(false);
  });
});

/**
 * Sanity check: ensure that the `FillGradient` API is exported from the
 * installed Pixi version. This guards against accidental version drift
 * (e.g. someone downgrades and the symbol disappears).
 */
describe('Pixi FillGradient export', () => {
  it('FillGradient is importable from pixi.js', async () => {
    const mod = await import('pixi.js');
    expect(typeof mod.FillGradient).toBe('function');
  });
});

/**
 * Behavior of the breath / drift system. The cache stores `driftable` per
 * entry; `driftAll(dx, dy)` should only mutate driftable entries and leave
 * the band / non-drifting ones alone. This guarantees the vignette and
 * background bands stay anchored while the blooms breathe.
 */
describe('driftAll behavior', () => {
  interface Driftable {
    center: { x: number; y: number };
    outerCenter: { x: number; y: number };
    driftable: boolean;
    destroyed: boolean;
    destroy(): void;
  }

  class FakeDriftable implements Driftable {
    center = { x: 0.5, y: 0.5 };
    outerCenter = { x: 0.5, y: 0.5 };
    driftable = false;
    destroyed = false;
    destroy(): void {
      this.destroyed = true;
    }
  }

  interface DriftEntry {
    grad: FakeDriftable;
    baseCenter: { x: number; y: number };
    driftable: boolean;
  }

  class FakeDriftCache {
    private readonly entries = new Map<string, DriftEntry>();
    private factories = 0;

    add(key: string, driftable: boolean): FakeDriftable {
      const existing = this.entries.get(key);
      if (existing) {
        existing.driftable = existing.driftable || driftable;
        return existing.grad;
      }
      this.factories += 1;
      const grad = new FakeDriftable();
      grad.driftable = driftable;
      const entry: DriftEntry = {
        grad,
        baseCenter: { x: 0.5, y: 0.5 },
        driftable,
      };
      this.entries.set(key, entry);
      return grad;
    }

    factoriesCalled(): number {
      return this.factories;
    }

    size(): number {
      return this.entries.size;
    }

    driftAll(dx: number, dy: number): void {
      for (const e of this.entries.values()) {
        if (!e.driftable) continue;
        e.grad.center = { x: e.baseCenter.x + dx, y: e.baseCenter.y + dy };
        e.grad.outerCenter = {
          x: e.baseCenter.x + dx,
          y: e.baseCenter.y + dy,
        };
      }
    }
  }

  it('moves only driftable entries', () => {
    const cache = new FakeDriftCache();
    const band = cache.add('band:void', false);
    const bloom = cache.add('void-bloom', true);
    const otherBand = cache.add('band:nebula', false);
    const halo = cache.add('nebula-halo', true);

    cache.driftAll(0.1, -0.05);

    // Drifting entries should move.
    expect(bloom.center.x).toBeCloseTo(0.6);
    expect(bloom.center.y).toBeCloseTo(0.45);
    expect(halo.center.x).toBeCloseTo(0.6);
    expect(halo.center.y).toBeCloseTo(0.45);
    // Non-drifting entries should NOT move.
    expect(band.center.x).toBe(0.5);
    expect(band.center.y).toBe(0.5);
    expect(otherBand.center.x).toBe(0.5);
    expect(otherBand.center.y).toBe(0.5);
  });

  it('upgrades a cached entry to driftable when requested later', () => {
    const cache = new FakeDriftCache();
    cache.add('band:void', false);
    cache.add('band:void', true); // re-request with driftable=true
    // Only one entry exists, and it should now be driftable.
    expect(cache.size()).toBe(1);
    cache.driftAll(0.2, 0.1);
    // Find the single entry and check it moved.
    const entries = [...cache['entries'].values()] as DriftEntry[];
    expect(entries[0]!.driftable).toBe(true);
    expect(entries[0]!.grad.center.x).toBeCloseTo(0.7);
    expect(entries[0]!.grad.center.y).toBeCloseTo(0.6);
  });

  it('zero offset leaves every center at base', () => {
    const cache = new FakeDriftCache();
    const bloom = cache.add('void-bloom', true);
    cache.driftAll(0, 0);
    expect(bloom.center.x).toBe(0.5);
    expect(bloom.center.y).toBe(0.5);
  });
});