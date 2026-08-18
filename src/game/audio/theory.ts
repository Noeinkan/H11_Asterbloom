/**
 * Pure music theory for the generative soundtrack.
 *
 * No Web Audio here — everything in this file is numbers, so it can be unit
 * tested in node. `audio.ts` owns the graph and asks this module *what* to
 * play; this module never decides *when* beyond handing out loop periods.
 *
 * Two invariants carry most of the musical weight:
 *
 *   1. Every melodic pitch is addressed as an integer step on a *pentatonic
 *      ladder*, so no amount of random variation can produce a sour note.
 *      Step 5 is one octave above step 0; negative steps go down.
 *   2. Chords move by scale degree inside a fixed key, so the harmony
 *      actually changes instead of the whole block sliding chromatically.
 */

import { mulberry32, pick, range, rangeInt, type Rng } from '../sim/rng';

export type ModeName =
  | 'phrygian'
  | 'aeolian'
  | 'dorian'
  | 'mixolydian'
  | 'lydian';

/** Semitone offsets of each mode, darkest first. */
export const MODES: Record<ModeName, readonly number[]> = {
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

/**
 * Scale degrees the progression walks: i, iv, v, VI, VII (0-based steps).
 * Deliberately no ii/vii° — both want to resolve, and nothing here resolves.
 */
export const PROGRESSION: readonly number[] = [0, 3, 4, 5, 6];

/**
 * Weighted transitions between the entries of `PROGRESSION`. The diagonal is
 * zero, so a chord never immediately repeats; the tonic is the strongest
 * attractor so the walk keeps coming home without ever cadencing hard.
 */
const TRANSITIONS: readonly (readonly number[])[] = [
  [0, 3, 2, 3, 2], // i   → iv v VI VII
  [3, 0, 2, 2, 1], // iv  → i  v VI VII
  [4, 1, 0, 1, 2], // v   → i  iv VI VII
  [2, 2, 1, 0, 3], // VI  → i  iv v  VII
  [3, 1, 2, 2, 0], // VII → i  iv v  VI
];

/**
 * Pad loop periods in seconds. Pairwise non-integer ratios, so the voices
 * never line up twice — the Music for Airports trick. Their combined cycle is
 * longer than any match, which is the whole point: the chord voicing keeps
 * recombining without anything ever restarting.
 */
export const PAD_PERIODS: readonly number[] = [16.2, 17.5, 19.7, 22.3, 25.1, 28.7];

/** Resolve a scale step (may be negative or past an octave) to semitones. */
export function scaleSemis(mode: ModeName, step: number): number {
  const scale = MODES[mode];
  const n = scale.length;
  const oct = Math.floor(step / n);
  return scale[((step % n) + n) % n]! + oct * 12;
}

/** Stacked-thirds chord on a scale degree, as semitones above the tonic. */
export function chordTones(mode: ModeName, degree: number, size = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i++) out.push(scaleSemis(mode, degree + i * 2));
  return out;
}

/**
 * The five pentatonic semitones for a mode. Minor-third modes get the minor
 * pentatonic (skip the 2nd and 6th), major-third modes the major pentatonic
 * (skip the 4th and 7th). Either way the avoid-notes are gone, which is why
 * the melody can be generated at random and still sound intentional.
 */
export function pentatonicSemis(mode: ModeName): number[] {
  const minorThird = MODES[mode][2] === 3;
  const steps = minorThird ? [0, 2, 3, 4, 6] : [0, 1, 2, 4, 5];
  return steps.map((s) => scaleSemis(mode, s));
}

/** Semitones above the tonic for an integer step on the pentatonic ladder. */
export function ladderSemis(mode: ModeName, step: number): number {
  const pent = pentatonicSemis(mode);
  const oct = Math.floor(step / 5);
  return pent[((step % 5) + 5) % 5]! + oct * 12;
}

/** Weighted Markov step between progression chords. Never repeats. */
export function nextChord(current: number, rng: Rng): number {
  const row = TRANSITIONS[current] ?? TRANSITIONS[0]!;
  let total = 0;
  for (const w of row) total += w;
  let roll = rng() * total;
  for (let i = 0; i < row.length; i++) {
    roll -= row[i]!;
    if (roll <= 0) return i;
  }
  return (current + 1) % row.length;
}

/**
 * Nudge a ladder step onto a tone of the current chord when one is within
 * reach. Still returns a ladder step, so the pentatonic guarantee holds — it
 * just makes the melody lean into the harmony instead of floating over it.
 */
export function anchorToChord(
  step: number,
  mode: ModeName,
  degree: number,
): number {
  const chord = new Set(
    chordTones(mode, degree, 3).map((s) => ((s % 12) + 12) % 12),
  );
  for (const delta of [0, -1, 1]) {
    const pc = ((ladderSemis(mode, step + delta) % 12) + 12) % 12;
    if (chord.has(pc)) return step + delta;
  }
  return step;
}

export interface MotifNote {
  /** Integer step on the pentatonic ladder. */
  step: number;
  /** Length in beats. */
  dur: number;
}

export type Motif = readonly MotifNote[];

const STEP_MOVES = [-2, -1, -1, 1, 1, 2, 3];
const DURATIONS = [0.5, 0.75, 1, 1, 1.5, 2];

const MIN_STEP = -3;
const MAX_STEP = 8;

function clampStep(step: number): number {
  return Math.max(MIN_STEP, Math.min(MAX_STEP, step));
}

/**
 * Build the match's theme: a short shape that will be recognisable when it
 * comes back. Seeded from the world seed, so a given map always has the same
 * tune — the same way its palette and starfield are seeded.
 */
export function makeMotif(rng: Rng): Motif {
  const count = rangeInt(rng, 4, 6);
  const notes: MotifNote[] = [];
  let step = rangeInt(rng, 0, 4);
  for (let i = 0; i < count; i++) {
    notes.push({ step, dur: pick(rng, DURATIONS) });
    step = clampStep(step + pick(rng, STEP_MOVES));
  }
  return notes;
}

type Variation = (motif: Motif, rng: Rng) => MotifNote[];

/**
 * Motivic development operators. Each one keeps `step` an integer, which is
 * what guarantees a variation can never generate an out-of-scale pitch.
 */
const VARIATIONS: readonly Variation[] = [
  // Transpose the whole phrase along the ladder.
  (m, rng) => {
    const by = pick(rng, [-3, -2, -1, 1, 2, 3]);
    return m.map((n) => ({ step: clampStep(n.step + by), dur: n.dur }));
  },
  // Displace one note by an octave.
  (m, rng) => {
    const i = rangeInt(rng, 0, m.length - 1);
    const by = rng() < 0.5 ? -5 : 5;
    return m.map((n, j) =>
      j === i ? { step: clampStep(n.step + by), dur: n.dur } : { ...n },
    );
  },
  // Augmentation — the phrase stretches out.
  (m) => m.map((n) => ({ step: n.step, dur: n.dur * 1.5 })),
  // Diminution — the phrase hurries.
  (m) => m.map((n) => ({ step: n.step, dur: n.dur * 0.667 })),
  // Leave a note out; the ear fills the gap.
  (m, rng) => {
    if (m.length <= 3) return m.map((n) => ({ ...n }));
    const i = rangeInt(rng, 0, m.length - 1);
    return m.filter((_, j) => j !== i).map((n) => ({ ...n }));
  },
  // Retrograde a fragment.
  (m, rng) => {
    const out = m.map((n) => ({ ...n }));
    if (out.length < 3) return out.reverse();
    const start = rangeInt(rng, 0, out.length - 3);
    const end = rangeInt(rng, start + 2, out.length - 1);
    const slice = out.slice(start, end + 1).reverse();
    for (let i = 0; i < slice.length; i++) out[start + i] = slice[i]!;
    return out;
  },
  // Insert a passing tone between two notes, splitting the first's length.
  (m, rng) => {
    const out = m.map((n) => ({ ...n }));
    if (out.length < 2) return out;
    const i = rangeInt(rng, 0, out.length - 2);
    const a = out[i]!;
    const b = out[i + 1]!;
    const mid = clampStep(Math.round((a.step + b.step) / 2));
    a.dur *= 0.5;
    out.splice(i + 1, 0, { step: mid, dur: a.dur });
    return out;
  },
];

/** Restate the theme, changed but still itself. */
export function varyMotif(motif: Motif, rng: Rng): MotifNote[] {
  const op = pick(rng, VARIATIONS);
  const out = op(motif, rng);
  return out.length > 0 ? out : motif.map((n) => ({ ...n }));
}

export interface Atmosphere {
  mode: ModeName;
  /** Whole semitones. Never fractional — quarter tones are what soured this. */
  transpose: number;
}

/** 30° hue sectors, so a drifting hue changes key 12 times per full wheel. */
export const HUE_SECTORS = 12;

const DARK_MODES: readonly ModeName[] = [
  'aeolian', 'aeolian', 'phrygian', 'phrygian', 'aeolian', 'aeolian',
  'dorian', 'dorian', 'aeolian', 'aeolian', 'phrygian', 'dorian',
];

const BRIGHT_MODES: readonly ModeName[] = [
  'dorian', 'mixolydian', 'mixolydian', 'lydian', 'lydian', 'mixolydian',
  'dorian', 'dorian', 'mixolydian', 'lydian', 'mixolydian', 'dorian',
];

/** Modest whole-semitone key centres, one per hue sector. */
const SECTOR_TRANSPOSE: readonly number[] = [
  0, 2, 3, 5, 3, 2, 0, -2, -3, -4, -2, -1,
];

/** Which of the 12 hue sectors a hue falls in. */
export function hueSector(hue: number): number {
  const h = ((hue % 360) + 360) % 360;
  return Math.floor(h / (360 / HUE_SECTORS)) % HUE_SECTORS;
}

/**
 * Hue picks the mode and the key centre. Quantised to a sector so the
 * continuously drifting hue does not retune the bed every frame.
 */
export function atmosphereForHue(hue: number, dark: boolean): Atmosphere {
  const sector = hueSector(hue);
  const table = dark ? DARK_MODES : BRIGHT_MODES;
  return { mode: table[sector]!, transpose: SECTOR_TRANSPOSE[sector]! };
}

/** Brighten (win) or darken (lose) the mode without changing the key. */
export function moodMode(mode: ModeName, mood: 'play' | 'won' | 'lost'): ModeName {
  if (mood === 'won') return MODES[mode][2] === 3 ? 'dorian' : 'lydian';
  if (mood === 'lost') return 'phrygian';
  return mode;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/** Seconds between bell strikes — busier as the match heats up. */
export function bellGapFor(intensity: number, rng: Rng): number {
  const mean = lerp(18, 6, intensity);
  return range(rng, mean * 0.55, mean * 1.45);
}

/** Seconds of rest between melodic phrases. */
export function phraseGapFor(intensity: number, rng: Rng): number {
  const mean = lerp(38, 16, intensity);
  return range(rng, mean * 0.7, mean * 1.3);
}

/** Pad low-pass cutoff in Hz. Dark scenes sit lower; action opens it up. */
export function padCutoffFor(intensity: number, dark: boolean): number {
  const base = dark ? 700 : 900;
  return lerp(base, base + 620, intensity);
}

/** Echo feedback — more space when the field is quiet. */
export function delayFeedbackFor(intensity: number): number {
  return lerp(0.52, 0.28, intensity);
}

/** Seconds between harmony changes. */
export function chordGapFor(rng: Rng): number {
  return range(rng, 40, 70);
}

/** Convenience for callers that only have a numeric seed. */
export function rngFromSeed(seed: number): Rng {
  return mulberry32((seed ^ 0x5eed_1e55) >>> 0);
}
