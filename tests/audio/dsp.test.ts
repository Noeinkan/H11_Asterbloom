import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/game/sim/rng';
import { makeNoiseChannel, makeReverbTail } from '../../src/game/audio/dsp';

const SR = 44100;

/**
 * Proxy for high-frequency content: the mean absolute sample-to-sample
 * difference, normalised by the mean level so a decaying signal is not
 * mistaken for a damped one.
 */
function brightness(data: Float32Array, from: number, to: number): number {
  let diff = 0;
  let level = 0;
  for (let i = from + 1; i < to; i++) {
    diff += Math.abs(data[i]! - data[i - 1]!);
    level += Math.abs(data[i]!);
  }
  return level === 0 ? 0 : diff / level;
}

function peakIn(data: Float32Array, from: number, to: number): number {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]!));
  return peak;
}

describe('reverb impulse response', () => {
  const tail = makeReverbTail(SR, 3, mulberry32(1));

  it('is stereo, the right length, and normalised', () => {
    expect(tail).toHaveLength(2);
    for (const ch of tail) {
      expect(ch.length).toBe(SR * 3);
      expect(peakIn(ch, 0, ch.length)).toBeCloseTo(0.9, 5);
    }
  });

  it('decorrelates the two channels so the tail spreads in stereo', () => {
    const [left, right] = tail as [Float32Array, Float32Array];
    let identical = true;
    for (let i = 0; i < 1000; i++) {
      if (left[i] !== right[i]) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(false);

    // Near-zero correlation, not just "different numbers".
    let dot = 0;
    let la = 0;
    let ra = 0;
    for (let i = 0; i < left.length; i++) {
      dot += left[i]! * right[i]!;
      la += left[i]! * left[i]!;
      ra += right[i]! * right[i]!;
    }
    expect(Math.abs(dot / Math.sqrt(la * ra))).toBeLessThan(0.1);
  });

  it('decays monotonically toward silence', () => {
    const ch = tail[0]!;
    const window = Math.floor(SR * 0.1);
    let previous = Infinity;
    for (let start = 0; start + window < ch.length; start += window) {
      const peak = peakIn(ch, start, start + window);
      if (start > 0) expect(peak).toBeLessThan(previous * 1.05);
      previous = Math.max(peak, 1e-9);
    }
    expect(peakIn(ch, ch.length - window, ch.length)).toBeLessThan(0.01);
  });

  it('fades in, so convolving a transient does not click', () => {
    const ch = tail[0]!;
    const onset = peakIn(ch, 0, 8);
    const settled = peakIn(ch, Math.floor(SR * 0.014), Math.floor(SR * 0.02));
    expect(onset).toBeLessThan(settled * 0.5);
  });

  // The detail that stops the reverb sounding like a hiss stapled to the mix.
  it('damps the tail so highs die before lows', () => {
    const ch = tail[0]!;
    const head = brightness(ch, 0, Math.floor(SR * 0.2));
    const end = brightness(ch, Math.floor(SR * 2.5), ch.length);
    expect(end).toBeLessThan(head * 0.6);
  });

  it('survives degenerate lengths without producing NaNs', () => {
    const tiny = makeReverbTail(SR, 0, mulberry32(2));
    for (const ch of tiny) {
      expect(ch.length).toBeGreaterThan(0);
      for (const v of ch) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('noise buffer', () => {
  const noise = makeNoiseChannel(SR, 1, mulberry32(9));

  it('stays inside the sample range', () => {
    expect(noise.length).toBe(SR);
    for (const v of noise) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it('is pink rather than white — less high-frequency fizz', () => {
    const white = new Float32Array(SR);
    const rng = mulberry32(9);
    for (let i = 0; i < SR; i++) white[i] = rng() * 2 - 1;
    expect(brightness(noise, 0, noise.length)).toBeLessThan(
      brightness(white, 0, white.length),
    );
  });

  it('is deterministic for a given seed', () => {
    expect(Array.from(makeNoiseChannel(SR, 0.01, mulberry32(4)))).toEqual(
      Array.from(makeNoiseChannel(SR, 0.01, mulberry32(4))),
    );
  });
});
