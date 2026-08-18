/**
 * Buffer generators for the audio engine.
 *
 * Kept free of Web Audio types so they can be tested in node: both functions
 * return raw `Float32Array` channels that `audio.ts` copies into an
 * `AudioBuffer`.
 */

import type { Rng } from '../sim/rng';

/** −60 dB at the end of the tail. */
const DECAY_K = 6.9;

/** Fade-in length, long enough to kill the onset click, short enough to hide. */
const FADE_IN_S = 0.015;

/** One-pole coefficient at the head and at the very end of the tail. */
const DAMP_START = 0.15;
const DAMP_END = 0.93;

/**
 * Impulse response for the convolution reverb.
 *
 * Three details separate this from "decaying white noise", which is what a
 * naive IR sounds like — a bright hiss stapled to the mix:
 *
 *   - each channel gets *independent* noise, so the tail is decorrelated and
 *     spreads across the stereo field instead of collapsing to the centre;
 *   - a one-pole low-pass whose coefficient tightens along the tail, so the
 *     highs die first the way they do in a real space;
 *   - a short fade-in, so convolving a transient does not click.
 */
export function makeReverbTail(
  sampleRate: number,
  seconds: number,
  rng: Rng,
): Float32Array<ArrayBuffer>[] {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const fadeIn = Math.max(1, Math.floor(sampleRate * FADE_IN_S));
  const channels: Float32Array<ArrayBuffer>[] = [];

  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(length);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const white = rng() * 2 - 1;
      // Damping tightens as the tail ages.
      const a = DAMP_START + (DAMP_END - DAMP_START) * t;
      lp = a * lp + (1 - a) * white;
      let v = lp * Math.exp(-DECAY_K * t);
      if (i < fadeIn) v *= i / fadeIn;
      data[i] = v;
    }
    // Normalise so reverb depth is set by the wet gain, not by the RNG.
    let peak = 0;
    for (let i = 0; i < length; i++) {
      const m = Math.abs(data[i]!);
      if (m > peak) peak = m;
    }
    if (peak > 0) {
      const scale = 0.9 / peak;
      for (let i = 0; i < length; i++) data[i]! *= scale;
    }
    channels.push(data);
  }
  return channels;
}

/**
 * Pink-ish noise (Paul Kellett's filter bank) for the percussive effects.
 * Pink rather than white because white reads as digital fizz on a soft-edged
 * game; pink sits under the music instead of on top of it.
 */
export function makeNoiseChannel(
  sampleRate: number,
  seconds: number,
  rng: Rng,
): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const data = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i++) {
    const white = rng() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    data[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.18) * 0.22));
  }
  return data;
}
