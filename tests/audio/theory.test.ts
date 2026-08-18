import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/game/sim/rng';
import {
  anchorToChord,
  atmosphereForHue,
  bellGapFor,
  chordTones,
  delayFeedbackFor,
  hueSector,
  ladderSemis,
  makeMotif,
  MODES,
  moodMode,
  nextChord,
  padCutoffFor,
  PAD_PERIODS,
  pentatonicSemis,
  phraseGapFor,
  PROGRESSION,
  rngFromSeed,
  scaleSemis,
  varyMotif,
  type ModeName,
} from '../../src/game/audio/theory';

const ALL_MODES = Object.keys(MODES) as ModeName[];

/** Pitch classes the pentatonic ladder is allowed to produce. */
function pentatonicClasses(mode: ModeName): Set<number> {
  return new Set(pentatonicSemis(mode).map((s) => ((s % 12) + 12) % 12));
}

describe('scales', () => {
  it('wraps scale steps across octaves in both directions', () => {
    expect(scaleSemis('aeolian', 0)).toBe(0);
    expect(scaleSemis('aeolian', 7)).toBe(12);
    expect(scaleSemis('aeolian', -7)).toBe(-12);
    expect(scaleSemis('aeolian', 9)).toBe(scaleSemis('aeolian', 2) + 12);
  });

  it('gives every mode a five-note pentatonic with no semitone clashes', () => {
    for (const mode of ALL_MODES) {
      const pent = pentatonicSemis(mode);
      expect(pent).toHaveLength(5);
      const sorted = [...pent].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps every ladder step inside the pentatonic set', () => {
    for (const mode of ALL_MODES) {
      const allowed = pentatonicClasses(mode);
      for (let step = -12; step <= 20; step++) {
        const pc = ((ladderSemis(mode, step) % 12) + 12) % 12;
        expect(allowed.has(pc)).toBe(true);
      }
    }
  });

  it('builds chords from stacked scale thirds', () => {
    // i in aeolian is a minor triad with a minor 7th on top.
    expect(chordTones('aeolian', 0, 4)).toEqual([0, 3, 7, 10]);
  });
});

describe('harmony walk', () => {
  it('never repeats a chord and never leaves the progression', () => {
    const rng = mulberry32(0xc0ffee);
    let current = 0;
    for (let i = 0; i < 2000; i++) {
      const next = nextChord(current, rng);
      expect(next).not.toBe(current);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(PROGRESSION.length);
      current = next;
    }
  });

  it('reaches every chord in the progression', () => {
    const rng = mulberry32(7);
    const seen = new Set<number>();
    let current = 0;
    for (let i = 0; i < 500; i++) {
      current = nextChord(current, rng);
      seen.add(current);
    }
    expect(seen.size).toBe(PROGRESSION.length);
  });

  it('anchors a step onto a chord tone without leaving the pentatonic', () => {
    for (const mode of ALL_MODES) {
      const allowed = pentatonicClasses(mode);
      for (const degree of PROGRESSION) {
        for (let step = -4; step <= 10; step++) {
          const anchored = anchorToChord(step, mode, degree);
          expect(Number.isInteger(anchored)).toBe(true);
          expect(Math.abs(anchored - step)).toBeLessThanOrEqual(1);
          const pc = ((ladderSemis(mode, anchored) % 12) + 12) % 12;
          expect(allowed.has(pc)).toBe(true);
        }
      }
    }
  });
});

describe('motif', () => {
  it('is deterministic for a given seed', () => {
    expect(makeMotif(rngFromSeed(42))).toEqual(makeMotif(rngFromSeed(42)));
    expect(makeMotif(rngFromSeed(42))).not.toEqual(makeMotif(rngFromSeed(43)));
  });

  it('produces playable notes', () => {
    for (let seed = 0; seed < 200; seed++) {
      const motif = makeMotif(rngFromSeed(seed));
      expect(motif.length).toBeGreaterThanOrEqual(4);
      expect(motif.length).toBeLessThanOrEqual(6);
      for (const note of motif) {
        expect(Number.isInteger(note.step)).toBe(true);
        expect(note.dur).toBeGreaterThan(0);
      }
    }
  });

  // The load-bearing test: this is what guarantees the random variation
  // machinery can never generate a sour note.
  it('keeps every varied note in the scale, for every mode', () => {
    const rng = mulberry32(0xbeef);
    for (const mode of ALL_MODES) {
      const allowed = pentatonicClasses(mode);
      for (let seed = 0; seed < 40; seed++) {
        let motif = makeMotif(rngFromSeed(seed));
        for (let gen = 0; gen < 40; gen++) {
          const varied = varyMotif(motif, rng);
          expect(varied.length).toBeGreaterThan(0);
          for (const note of varied) {
            expect(Number.isInteger(note.step)).toBe(true);
            expect(note.dur).toBeGreaterThan(0);
            const pc = ((ladderSemis(mode, note.step) % 12) + 12) % 12;
            expect(allowed.has(pc)).toBe(true);
          }
          // Vary from the original each time, as the engine does, but also
          // walk a chain now and then to catch cumulative drift.
          motif = gen % 4 === 3 ? varied : motif;
        }
      }
    }
  });

  it('does not mutate the motif it was given', () => {
    const rng = mulberry32(11);
    const motif = makeMotif(rngFromSeed(5));
    const before = JSON.stringify(motif);
    for (let i = 0; i < 200; i++) varyMotif(motif, rng);
    expect(JSON.stringify(motif)).toBe(before);
  });
});

describe('hue mapping', () => {
  it('only ever transposes by whole semitones', () => {
    for (let hue = -720; hue <= 1080; hue += 0.5) {
      for (const dark of [true, false]) {
        const { transpose } = atmosphereForHue(hue, dark);
        expect(Number.isInteger(transpose)).toBe(true);
        expect(Math.abs(transpose)).toBeLessThanOrEqual(6);
      }
    }
  });

  it('is stable across a whole 30 degree sector', () => {
    for (let sector = 0; sector < 12; sector++) {
      const base = atmosphereForHue(sector * 30 + 0.001, true);
      for (let d = 0; d < 30; d += 0.5) {
        const hue = sector * 30 + d;
        expect(hueSector(hue)).toBe(sector);
        expect(atmosphereForHue(hue, true)).toEqual(base);
      }
    }
  });

  it('wraps negative and over-360 hues', () => {
    expect(atmosphereForHue(-10, true)).toEqual(atmosphereForHue(350, true));
    expect(atmosphereForHue(400, false)).toEqual(atmosphereForHue(40, false));
  });

  it('brightens on a win and darkens on a loss', () => {
    for (const mode of ALL_MODES) {
      expect(moodMode(mode, 'play')).toBe(mode);
      expect(moodMode(mode, 'lost')).toBe('phrygian');
      // Third of the won mode is never lower than the third it came from.
      expect(MODES[moodMode(mode, 'won')][2]).toBeGreaterThanOrEqual(
        MODES[mode][2],
      );
    }
  });
});

describe('pad loop periods', () => {
  it('are pairwise incommensurable, so the voicing never repeats', () => {
    for (let i = 0; i < PAD_PERIODS.length; i++) {
      for (let j = i + 1; j < PAD_PERIODS.length; j++) {
        const ratio = PAD_PERIODS[j]! / PAD_PERIODS[i]!;
        // Not a whole-number ratio...
        expect(Math.abs(ratio - Math.round(ratio))).toBeGreaterThan(0.05);
        // ...and not a simple fraction either.
        for (const den of [2, 3, 4, 5]) {
          const scaled = ratio * den;
          expect(Math.abs(scaled - Math.round(scaled))).toBeGreaterThan(0.05);
        }
      }
    }
  });

  it('take longer than any match to realign', () => {
    // In tenths of a second all periods are integers; their LCM is the point
    // at which the bed would repeat itself.
    const tenths = PAD_PERIODS.map((p) => Math.round(p * 10));
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const lcm = tenths.reduce((a, b) => (a / gcd(a, b)) * b);
    expect(lcm / 10).toBeGreaterThan(60 * 60 * 24);
  });
});

describe('intensity mapping', () => {
  it('makes bells and phrases denser as intensity rises', () => {
    const calm = mulberry32(3);
    const hot = mulberry32(3);
    let calmTotal = 0;
    let hotTotal = 0;
    for (let i = 0; i < 400; i++) {
      calmTotal += bellGapFor(0, calm);
      hotTotal += bellGapFor(1, hot);
    }
    expect(hotTotal).toBeLessThan(calmTotal);

    const calmP = mulberry32(3);
    const hotP = mulberry32(3);
    expect(phraseGapFor(1, hotP)).toBeLessThan(phraseGapFor(0, calmP));
  });

  it('opens the pad filter and shortens the echoes under pressure', () => {
    expect(padCutoffFor(1, true)).toBeGreaterThan(padCutoffFor(0, true));
    expect(padCutoffFor(0, false)).toBeGreaterThan(padCutoffFor(0, true));
    expect(delayFeedbackFor(1)).toBeLessThan(delayFeedbackFor(0));
    expect(delayFeedbackFor(0)).toBeLessThan(1);
  });

  it('clamps out-of-range intensity instead of running away', () => {
    expect(padCutoffFor(5, true)).toBe(padCutoffFor(1, true));
    expect(padCutoffFor(-5, true)).toBe(padCutoffFor(0, true));
    expect(delayFeedbackFor(9)).toBe(delayFeedbackFor(1));
  });
});
