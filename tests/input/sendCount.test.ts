import { describe, expect, it } from 'vitest';
import {
  adjustSendCount,
  bumpSendCount,
  closestPreset,
  countFromDialAngle,
  dialAngleForCount,
  resolveSendCount,
  resolveSendExact,
} from '../../src/game/input/sendCount';

describe('resolveSendCount', () => {
  it('returns 0 when no orbiters', () => {
    expect(resolveSendCount(0, 'all', 99)).toBe(0);
    expect(resolveSendCount(0, 'scout', 1)).toBe(0);
    expect(resolveSendCount(0, 'half', 1)).toBe(0);
    expect(resolveSendCount(0, 'fixed', 5)).toBe(0);
  });

  it('sends all orbiters in all mode', () => {
    expect(resolveSendCount(12, 'all', 3)).toBe(12);
  });

  it('sends one in scout mode', () => {
    expect(resolveSendCount(12, 'scout', 99)).toBe(1);
  });

  it('sends half rounded up in half mode', () => {
    expect(resolveSendCount(1, 'half', 0)).toBe(1);
    expect(resolveSendCount(6, 'half', 0)).toBe(3);
    expect(resolveSendCount(7, 'half', 0)).toBe(4);
    expect(resolveSendCount(12, 'half', 0)).toBe(6);
  });

  it('clamps fixed count to available orbiters', () => {
    expect(resolveSendCount(10, 'fixed', 4)).toBe(4);
    expect(resolveSendCount(10, 'fixed', 40)).toBe(10);
    expect(resolveSendCount(10, 'fixed', 0)).toBe(0);
    expect(resolveSendCount(10, 'fixed', -3)).toBe(0);
  });
});

describe('resolveSendExact', () => {
  it('clamps a target count to the available orbiters', () => {
    expect(resolveSendExact(0, 5)).toBe(0);
    expect(resolveSendExact(10, 4)).toBe(4);
    expect(resolveSendExact(10, 40)).toBe(10);
    expect(resolveSendExact(10, -2)).toBe(0);
  });

  it('ignores fractional inputs', () => {
    expect(resolveSendExact(10, 3.7)).toBe(3);
  });
});

describe('adjustSendCount', () => {
  it('returns 0 when empty', () => {
    expect(adjustSendCount(0, 5, 1)).toBe(0);
  });

  it('clamps between 0 and max', () => {
    expect(adjustSendCount(10, 5, 1)).toBe(6);
    expect(adjustSendCount(10, 5, -1)).toBe(4);
    expect(adjustSendCount(10, 10, 1)).toBe(10);
    expect(adjustSendCount(10, 0, -1)).toBe(0);
  });

  it('allows jumping by negative offsets', () => {
    expect(adjustSendCount(10, 5, -10)).toBe(0);
  });
});

describe('bumpSendCount', () => {
  it('returns 0 when empty', () => {
    expect(bumpSendCount(0, 5, 1)).toBe(0);
  });

  it('clamps between 1 and max', () => {
    expect(bumpSendCount(10, 5, 1)).toBe(6);
    expect(bumpSendCount(10, 5, -1)).toBe(4);
    expect(bumpSendCount(10, 10, 1)).toBe(10);
    expect(bumpSendCount(10, 1, -1)).toBe(1);
  });

  it('stays at 1 when stepping down past 1', () => {
    expect(bumpSendCount(10, 1, -5)).toBe(1);
  });
});

describe('closestPreset', () => {
  it('returns fixed when no orbiters', () => {
    expect(closestPreset(0, 0)).toBe('fixed');
  });

  it('matches scout, half, all when count matches', () => {
    expect(closestPreset(12, 1)).toBe('scout');
    expect(closestPreset(12, 6)).toBe('half');
    expect(closestPreset(12, 12)).toBe('all');
  });

  it('falls back to fixed for arbitrary counts', () => {
    expect(closestPreset(12, 5)).toBe('fixed');
    expect(closestPreset(12, 7)).toBe('fixed');
  });
});

describe('countFromDialAngle', () => {
  it('returns 0 when there are no orbiters', () => {
    expect(countFromDialAngle(0, 0)).toBe(0);
    expect(countFromDialAngle(0, Math.PI)).toBe(0);
  });

  it('returns 0 at the start of the sweep (cursor at 12 o\'clock)', () => {
    // Cursor at the top of the dial: (0, -1) → angle = -π/2.
    expect(countFromDialAngle(10, -Math.PI / 2)).toBe(0);
  });

  it('grows linearly as the dial sweeps CW from the top', () => {
    const max = 8;
    // Cursor at 3 o'clock (right): angle = 0 → frac 1/4 → 2 of 8.
    expect(countFromDialAngle(max, 0)).toBe(2);
    // Cursor at 6 o'clock (bottom): angle = +π/2 → frac 1/2 → 4 of 8.
    expect(countFromDialAngle(max, Math.PI / 2)).toBe(4);
    // Cursor at 9 o'clock (left): angle = +π → frac 3/4 → 6 of 8.
    expect(countFromDialAngle(max, Math.PI)).toBe(6);
  });

  it('drops back to 0 after a full revolution from the top', () => {
    // The forward mapping is half-open, so an angle just past the start
    // (mod 2π) sits in the last slice. A full revolution (back to the
    // top) lands cleanly at 0, mirroring the dial's geometry.
    const atTop = countFromDialAngle(10, -Math.PI / 2);
    expect(atTop).toBe(0);
    const justBefore = countFromDialAngle(10, -Math.PI / 2 - 0.001);
    expect(justBefore).toBe(9);
  });

  it('clamps negative inputs into the valid range', () => {
    expect(countFromDialAngle(10, -Math.PI * 3)).toBeGreaterThanOrEqual(0);
    expect(countFromDialAngle(10, -Math.PI * 3)).toBeLessThanOrEqual(10);
  });
});

describe('dialAngleForCount', () => {
  it('returns 0 when there are no orbiters', () => {
    expect(dialAngleForCount(0, 0)).toBe(0);
    expect(dialAngleForCount(0, 5)).toBe(0);
  });

  it('returns the top-of-dial angle for zero seedlings', () => {
    expect(dialAngleForCount(10, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('returns the bottom angle for half of an odd max', () => {
    // 9 slices → 4.5 slices from the top lands cleanly at slice 4's
    // midpoint (4 + 0.5) * (2π/9), which is just past 6 o'clock.
    const slice = (Math.PI * 2) / 9;
    const expected = -Math.PI / 2 + 4.5 * slice;
    expect(dialAngleForCount(9, 4)).toBeCloseTo(expected, 5);
  });

  it('round-trips with countFromDialAngle for counts below max', () => {
    const max = 8;
    for (let i = 0; i < max; i++) {
      const angle = dialAngleForCount(max, i);
      const back = countFromDialAngle(max, angle);
      expect(back).toBe(i);
    }
  });
});
