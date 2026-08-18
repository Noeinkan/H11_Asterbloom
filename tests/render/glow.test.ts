import { describe, expect, it } from 'vitest';
import {
  glowPeakAlpha,
  glowRamp,
  glowRingAlphas,
} from '../../src/game/render/glow';

/**
 * The glow ramp replaced a stack of N filled circles with one gradient
 * ellipse. These tests pin the arithmetic that has to keep matching the old
 * loop: ring weights `u²` with `u = 1 - i/n`, the partial sums that become the
 * baked ramp, and the `over`-composite the peak alpha has to reproduce.
 *
 * Baking the texture needs a canvas, so it is not exercised here — but the
 * texture is nothing more than `glowRamp` sampled over a disc, which is.
 */

describe('glowRingAlphas', () => {
  it('starts at 1, because the outermost ring drew at the full alpha', () => {
    expect(glowRingAlphas(5)[0]).toBe(1);
  });

  it('matches the u² weights of the loop it replaced', () => {
    const a = glowRingAlphas(5);
    [1, 0.64, 0.36, 0.16, 0.04].forEach((want, i) => {
      expect(a[i]!).toBeCloseTo(want, 10);
    });
  });

  it('decreases outward from the centre', () => {
    const a = glowRingAlphas(6);
    for (let i = 1; i < a.length; i++) {
      expect(a[i]!).toBeLessThan(a[i - 1]!);
    }
  });

  it('clamps degenerate ring counts the way the old loop did', () => {
    expect(glowRingAlphas(1)).toHaveLength(2);
    expect(glowRingAlphas(0)).toHaveLength(2);
    expect(glowRingAlphas(99)).toHaveLength(8);
  });
});

describe('glowRamp', () => {
  it('peaks at 1 in the centre, where every ring overlaps', () => {
    expect(glowRamp(0, 5)).toBe(1);
  });

  it('drops to the outermost ring alone at the rim', () => {
    // Only u = 1 reaches the rim: 1 / (1 + .64 + .36 + .16 + .04).
    expect(glowRamp(1, 5)).toBeCloseTo(1 / 2.2, 10);
  });

  it('sums exactly the rings that reach a given radius', () => {
    // u >= 0.5 covers u = 1, .8 and .6 -> (1 + .64 + .36) / 2.2.
    expect(glowRamp(0.5, 5)).toBeCloseTo(2 / 2.2, 10);
  });

  it('is zero outside the disc', () => {
    expect(glowRamp(1.0001, 5)).toBe(0);
    expect(glowRamp(4, 5)).toBe(0);
  });

  it('never increases outward', () => {
    for (let n = 2; n <= 6; n++) {
      let prev = Infinity;
      for (let i = 0; i <= 64; i++) {
        const v = glowRamp(i / 64, n);
        expect(v).toBeLessThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe('glowPeakAlpha', () => {
  it('reproduces the over-composite of the stacked rings, not their sum', () => {
    // 1 - Π(1 - 0.16·eᵢ) for n = 5. A plain sum would give 0.352, ~13% high.
    expect(glowPeakAlpha(0.16, 5)).toBeCloseTo(0.312067, 5);
  });

  it('stays under the naive sum, which is what the old stack could not exceed', () => {
    const sum = glowRingAlphas(5).reduce((a, b) => a + b, 0) * 0.16;
    expect(glowPeakAlpha(0.16, 5)).toBeLessThan(sum);
  });

  it('is 0 at alpha 0 and saturates at alpha 1', () => {
    expect(glowPeakAlpha(0, 5)).toBe(0);
    expect(glowPeakAlpha(1, 5)).toBe(1);
  });

  it('rises with the caller alpha', () => {
    let prev = -1;
    for (let a = 0; a <= 1.0001; a += 0.05) {
      const v = glowPeakAlpha(a, 4);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});
