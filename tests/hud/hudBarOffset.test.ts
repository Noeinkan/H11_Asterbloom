import { describe, expect, it } from 'vitest';
import {
  HUD_BAR_GAP_PX,
  hudBarOffsetPx,
} from '../../src/game/hud/hudBarOffset';

/**
 * The bottom bar wraps on narrow screens and grows with the HUD scale pref,
 * so every widget pinned above it measures the bar rather than assuming a
 * height. Getting this wrong buries the faction plate or the minimap under
 * the inspector, which is exactly the case the arithmetic below pins down.
 */
describe('hudBarOffsetPx', () => {
  it('clears the safe area, the bar, and a gap', () => {
    expect(hudBarOffsetPx(12, 40)).toBe(12 + 40 + HUD_BAR_GAP_PX);
  });

  it('grows when the bar wraps to a second line', () => {
    const one = hudBarOffsetPx(12, 40);
    const two = hudBarOffsetPx(12, 80);
    expect(two).toBeGreaterThan(one);
    expect(two - one).toBe(40);
  });

  it('still clears the safe area when there is no bar', () => {
    expect(hudBarOffsetPx(20, 0)).toBe(20 + HUD_BAR_GAP_PX);
  });

  it('honours an explicit gap', () => {
    expect(hudBarOffsetPx(12, 40, 0)).toBe(52);
  });

  it('falls back to the CSS default for an unreadable safe area', () => {
    // getComputedStyle returns '' before layout; parseFloat gives NaN.
    expect(hudBarOffsetPx(Number.NaN, 40)).toBe(12 + 40 + HUD_BAR_GAP_PX);
    expect(hudBarOffsetPx(0, 40)).toBe(12 + 40 + HUD_BAR_GAP_PX);
  });

  it('ignores a negative or non-finite bar height', () => {
    expect(hudBarOffsetPx(12, -5)).toBe(12 + HUD_BAR_GAP_PX);
    expect(hudBarOffsetPx(12, Number.NaN)).toBe(12 + HUD_BAR_GAP_PX);
  });

  it('always returns a usable positive offset', () => {
    for (const safe of [Number.NaN, -1, 0, 12, 44]) {
      for (const bar of [Number.NaN, -10, 0, 40, 120]) {
        const px = hudBarOffsetPx(safe, bar);
        expect(Number.isFinite(px)).toBe(true);
        expect(px).toBeGreaterThan(0);
      }
    }
  });
});
