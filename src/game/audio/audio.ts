/**
 * Procedural soundtrack + SFX (Web Audio, no samples).
 *
 * The bed is event-based, not a held chord. Six pad voices each re-trigger on
 * their own loop period, and because those periods share no common multiple
 * the voicing recombines forever without repeating — the tape-loop trick from
 * Eno's "Music for Airports". Over that, a short motif generated from the
 * world seed comes back every half minute or so, each time put through one
 * motivic variation, so the track has something to recognise without turning
 * into a jingle. Harmony walks a weighted Markov chain over scale degrees in
 * a fixed key; the scene hue picks the mode and the key centre, in whole
 * semitones only.
 *
 * All the pitch decisions live in `theory.ts` and all the buffer generation in
 * `dsp.ts`; this file is the audio graph and the scheduler.
 */

import { mulberry32, pick, range, type Rng } from '../sim/rng';
import type { TreeKind } from '../sim/types';
import { makeNoiseChannel, makeReverbTail } from './dsp';
import {
  atmosphereForHue,
  bellGapFor,
  chordGapFor,
  chordTones,
  delayFeedbackFor,
  ladderSemis,
  makeMotif,
  moodMode,
  nextChord,
  padCutoffFor,
  phraseGapFor,
  PAD_PERIODS,
  PROGRESSION,
  rngFromSeed,
  varyMotif,
  anchorToChord,
  type ModeName,
  type Motif,
} from './theory';

/** Key centre reference — the tonic sits here before transposition. */
const A2 = 110;

const MASTER = 0.42;
const MUSIC_GAIN = 0.62;
const SFX_GAIN = 0.8;

const REVERB_SECONDS = 4.5;
const PRE_DELAY_S = 0.028;

/** Drifting echo lengths (seconds). Prime-ish so they never align. */
const DELAY_A_BASE = 3.7;
const DELAY_B_BASE = 5.2;

/** Lookahead scheduler: check often, schedule a little way ahead. */
const TICK_MS = 40;
const LOOKAHEAD_S = 0.35;

/** Octave offset per pad voice, paired with a chord tone by index. */
const PAD_OCTAVES = [-12, 0, 12, 0, 12, 24];
const PAD_GAINS = [0.055, 0.038, 0.03, 0.026, 0.022, 0.016];

/** Inharmonic modulator ratios — non-integer is what makes a bell a bell. */
const BELL_RATIOS = [2.61, 3.47, 4.73];

type Mood = 'play' | 'won' | 'lost';

/** A slow oscillator added on top of an AudioParam's own value. */
class LFO {
  osc: OscillatorNode;
  scaler: GainNode;
  constructor(ctx: AudioContext, freqHz: number, depth: number, dest: AudioParam) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = Math.max(0.001, freqHz);
    this.scaler = ctx.createGain();
    this.scaler.gain.value = depth;
    this.osc.connect(this.scaler);
    this.scaler.connect(dest);
  }
  start(when: number): void {
    this.osc.start(when);
  }
  stop(): void {
    try {
      this.osc.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.osc.disconnect();
      this.scaler.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

export class GameAudio {
  private ctx: AudioContext | null = null;

  // Output chain.
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;

  // Music buses.
  private musicBus: GainNode | null = null;
  private musicOut: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private preDelay: DelayNode | null = null;
  private reverb: ConvolverNode | null = null;
  private extraSend: GainNode | null = null;

  private delayA: DelayNode | null = null;
  private delayB: DelayNode | null = null;
  private delayAFb: GainNode | null = null;
  private delayBFb: GainNode | null = null;
  private delayALfo: LFO | null = null;
  private delayBLfo: LFO | null = null;

  // Effects buses.
  private sfx: GainNode | null = null;
  private sfxSend: GainNode | null = null;

  private noise: AudioBuffer | null = null;
  private warm: PeriodicWave | null = null;

  private enabled = true;
  private unlocked = false;
  private dark = true;
  private mood: Mood = 'play';
  private intensity = 0.35;

  // Musical state.
  private rng: Rng = mulberry32(0x1234_5678);
  private mode: ModeName = 'aeolian';
  private transpose = 0;
  private chordIdx = 0;
  private motif: Motif = [];

  // Scheduler state (absolute AudioContext times).
  private schedTimer: number | null = null;
  private nextPad: number[] = [];
  private nextBell = 0;
  private nextPhrase = 0;
  private nextChordAt = 0;
  private nextSub = 0;
  private running = false;

  private lastClashAt = 0;
  private lastDeathAt = 0;
  private lastBurnAt = 0;
  private lastCaptureAt = 0;

  private gesturesBound = false;

  constructor() {
    this.rng = rngFromSeed(Math.floor(Math.random() * 0xffff_ffff));
    this.motif = makeMotif(this.rng);
    this.bindGestures();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ---------------------------------------------------------------- context

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (this.ctx) return this.ctx;

    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      ctx = new AC();
    }
    this.ctx = ctx;

    const bufRng = mulberry32(0x9e37_79b9);
    const tail = makeReverbTail(ctx.sampleRate, REVERB_SECONDS, bufRng);
    const ir = ctx.createBuffer(2, tail[0]!.length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) ir.copyToChannel(tail[ch]!, ch);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;

    const noiseCh = makeNoiseChannel(ctx.sampleRate, 2, bufRng);
    this.noise = ctx.createBuffer(1, noiseCh.length, ctx.sampleRate);
    this.noise.copyToChannel(noiseCh, 0);
    this.warm = makeWarmWave(ctx);

    // Master: a gentle compressor glues the stacked voices so the whole mix
    // can sit louder without the pad peaks clipping the effects.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 20;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.01;
    this.comp.release.value = 0.4;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? MASTER : 0.0001;

    this.musicBus = ctx.createGain();
    this.musicOut = ctx.createGain();
    this.musicOut.gain.value = MUSIC_GAIN;
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0.62;
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.5;
    this.preDelay = ctx.createDelay(0.5);
    this.preDelay.delayTime.value = PRE_DELAY_S;
    this.extraSend = ctx.createGain();
    this.extraSend.gain.value = 0.55;

    // Dry path, and a pre-delayed send into the reverb.
    this.musicBus.connect(this.dryGain);
    this.dryGain.connect(this.musicOut);
    this.musicBus.connect(this.preDelay);
    this.extraSend.connect(this.preDelay);
    this.preDelay.connect(this.reverb);
    this.reverb.connect(this.wetGain);
    this.wetGain.connect(this.musicOut);

    // Two echoes, actually fed this time, each darkening as it repeats.
    const mkDelay = (base: number, fb: number, wet: number) => {
      const delay = ctx.createDelay(8);
      delay.delayTime.value = base;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 1400;
      damp.Q.value = 0.4;
      const feedback = ctx.createGain();
      feedback.gain.value = fb;
      const out = ctx.createGain();
      out.gain.value = wet;

      this.musicBus!.connect(delay);
      delay.connect(damp);
      damp.connect(feedback);
      feedback.connect(delay);
      damp.connect(out);
      out.connect(this.musicOut!);
      return { delay, feedback };
    };
    const a = mkDelay(DELAY_A_BASE, 0.42, 0.3);
    const b = mkDelay(DELAY_B_BASE, 0.36, 0.26);
    this.delayA = a.delay;
    this.delayAFb = a.feedback;
    this.delayB = b.delay;
    this.delayBFb = b.feedback;
    this.delayALfo = new LFO(ctx, 0.018, DELAY_A_BASE * 0.02, this.delayA.delayTime);
    this.delayBLfo = new LFO(ctx, 0.013, DELAY_B_BASE * 0.02, this.delayB.delayTime);

    this.musicOut.connect(this.master);

    // Effects get their own send into the same reverb, so they sound like
    // they happen in the same room as the music instead of on top of it.
    this.sfx = ctx.createGain();
    this.sfx.gain.value = SFX_GAIN;
    this.sfxSend = ctx.createGain();
    this.sfxSend.gain.value = 0.3;
    this.sfx.connect(this.master);
    this.sfxSend.connect(this.preDelay);

    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    this.applyIntensity(0);
    return ctx;
  }

  private bindGestures(): void {
    if (this.gesturesBound || typeof document === 'undefined') return;
    this.gesturesBound = true;
    const kick = () => this.startAmbient();
    document.addEventListener('pointerdown', kick);
    document.addEventListener('keydown', kick);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Nothing to listen to on a hidden tab — stop burning cycles.
        void this.ctx?.suspend().catch(() => {});
      } else if (this.enabled) {
        this.startAmbient();
      }
    });
  }

  startAmbient(): void {
    this.whenRunning(() => {});
  }

  stopAmbient(): void {
    this.stopScheduler();
  }

  private whenRunning(fn: () => void): void {
    this.unlocked = true;
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const go = () => {
      if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
      this.startScheduler();
      fn();
    };
    if (ctx.state === 'running') {
      go();
      return;
    }
    void ctx.resume().then(go).catch(() => {});
  }

  // -------------------------------------------------------------- lifecycle

  setAtmosphere(hue: number, dark: boolean): void {
    const atmos = atmosphereForHue(hue, dark);
    const mode = moodMode(atmos.mode, this.mood);
    // main.ts calls this on every 1° of hue drift. Bail out unless the
    // quantised sector actually moved — retuning on every degree is what made
    // the old bed slide around permanently.
    if (mode === this.mode && atmos.transpose === this.transpose && dark === this.dark) {
      return;
    }
    this.dark = dark;
    this.mode = mode;
    this.transpose = atmos.transpose;
    this.applyIntensity(1.5);
  }

  beginMatch(hue: number, dark: boolean, seed?: number): void {
    this.mood = 'play';
    // Seed the music from the world seed, the way the palette and starfield
    // are, so a given map always comes with the same theme.
    this.rng = rngFromSeed(seed ?? Math.floor(Math.random() * 0xffff_ffff));
    this.motif = makeMotif(this.rng);
    this.chordIdx = 0;
    this.dark = !dark; // force setAtmosphere past its early-out
    this.setAtmosphere(hue, dark);
    this.resetSchedule();
  }

  /**
   * How hot the match is, 0..1. Drives bell density, phrase frequency, pad
   * brightness and echo length — the music leans in when the field does.
   */
  setIntensity(x: number): void {
    const next = Math.max(0, Math.min(1, x));
    if (Math.abs(next - this.intensity) < 0.02) return;
    this.intensity = next;
    this.applyIntensity(4);
  }

  private applyIntensity(timeConstant: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const fb = delayFeedbackFor(this.intensity);
    this.delayAFb?.gain.setTargetAtTime(fb, now, Math.max(0.01, timeConstant));
    this.delayBFb?.gain.setTargetAtTime(
      fb * 0.85,
      now,
      Math.max(0.01, timeConstant),
    );
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(on ? MASTER : 0.0001, now);
    }
    if (!on) {
      this.stopScheduler();
      void this.ctx?.suspend().catch(() => {});
      return;
    }
    if (this.unlocked) this.startAmbient();
  }

  // -------------------------------------------------------------- scheduler

  private startScheduler(): void {
    if (this.running || !this.ctx) return;
    this.running = true;
    this.resetSchedule();
    this.delayALfo?.start(this.ctx.currentTime + 0.05);
    this.delayBLfo?.start(this.ctx.currentTime + 0.05);
    this.schedTimer = window.setInterval(() => this.pump(), TICK_MS);
    this.pump();
  }

  private stopScheduler(): void {
    if (this.schedTimer !== null) {
      window.clearInterval(this.schedTimer);
      this.schedTimer = null;
    }
    this.running = false;
  }

  private resetSchedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime + 0.1;
    // Stagger the pad entries so the bed fades up rather than slamming in.
    this.nextPad = PAD_PERIODS.map((_, i) => now + i * 1.7);
    this.nextBell = now + range(this.rng, 6, 14);
    this.nextPhrase = now + range(this.rng, 12, 26);
    this.nextChordAt = now + chordGapFor(this.rng);
    this.nextSub = now + 2;
  }

  /** Lookahead pump: schedule everything that falls inside the next window. */
  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || !this.running || !this.enabled) return;
    if (ctx.state !== 'running') return;
    const until = ctx.currentTime + LOOKAHEAD_S;

    while (this.nextChordAt < until) {
      this.chordIdx = nextChord(this.chordIdx, this.rng);
      this.nextChordAt += chordGapFor(this.rng);
    }

    for (let i = 0; i < this.nextPad.length; i++) {
      while (this.nextPad[i]! < until) {
        this.padNote(i, this.nextPad[i]!);
        this.nextPad[i]! += PAD_PERIODS[i]!;
      }
    }

    while (this.nextBell < until) {
      this.bell(this.nextBell);
      this.nextBell += bellGapFor(this.intensity, this.rng);
    }

    while (this.nextPhrase < until) {
      const dur = this.phrase(this.nextPhrase);
      this.nextPhrase += dur + phraseGapFor(this.intensity, this.rng);
    }

    while (this.nextSub < until) {
      this.subSwell(this.nextSub);
      this.nextSub += range(this.rng, 22, 34);
    }
  }

  /** Hz for a semitone offset from the transposed tonic. */
  private freq(semis: number): number {
    return A2 * 2 ** ((this.transpose + semis) / 12);
  }

  private degree(): number {
    return PROGRESSION[this.chordIdx] ?? 0;
  }

  // ------------------------------------------------------------------ voices

  /**
   * One long pad note. Two oscillators a few cents apart give the beating
   * warmth; the panner drifts across the note so the bed is wide.
   */
  private padNote(voice: number, when: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;

    const tones = chordTones(this.mode, this.degree(), 4);
    const semis = tones[voice % tones.length]! + (PAD_OCTAVES[voice] ?? 0);
    const f = this.freq(semis);
    const peak = PAD_GAINS[voice] ?? 0.02;

    const attack = range(this.rng, 3.5, 5);
    const hold = range(this.rng, 5, 9);
    const release = range(this.rng, 5, 8);
    const end = when + attack + hold + release;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    filter.frequency.value = padCutoffFor(this.intensity, this.dark);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setValueAtTime(peak, when + attack + hold);
    g.gain.linearRampToValueAtTime(0.0001, end);

    const panner = ctx.createStereoPanner();
    const side = voice % 2 === 0 ? -1 : 1;
    const p0 = side * range(this.rng, 0.15, 0.5);
    panner.pan.setValueAtTime(p0, when);
    panner.pan.linearRampToValueAtTime(p0 * range(this.rng, 0.3, 0.9), end);

    const oscs: OscillatorNode[] = [];
    for (const cents of [-1, 1]) {
      const osc = ctx.createOscillator();
      osc.type = voice < 2 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      osc.detune.value = cents * range(this.rng, 5, 9);
      osc.connect(g);
      osc.start(when);
      osc.stop(end + 0.05);
      oscs.push(osc);
    }

    g.connect(filter);
    filter.connect(panner);
    panner.connect(bus);

    oscs[0]!.addEventListener(
      'ended',
      () => {
        for (const o of oscs) safeDisconnect(o);
        safeDisconnect(g);
        safeDisconnect(filter);
        safeDisconnect(panner);
      },
      { once: true },
    );
  }

  /**
   * FM strike. The modulator dies in a moment while the carrier rings on —
   * that gap between the two envelopes is the whole difference between a bell
   * and a sine tone.
   */
  private fmStrike(opts: {
    when: number;
    freq: number;
    ratio: number;
    index: number;
    modDecay: number;
    decay: number;
    gain: number;
    pan: number;
    send: number;
  }): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const { when } = opts;
    const end = when + opts.decay;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = opts.freq;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = opts.freq * opts.ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(opts.freq * opts.index, when);
    modGain.gain.exponentialRampToValueAtTime(1, when + opts.modDecay);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(opts.gain, when + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);

    const panner = ctx.createStereoPanner();
    panner.pan.value = opts.pan;

    carrier.connect(amp);
    amp.connect(panner);
    panner.connect(bus);
    if (this.extraSend && opts.send > 0) {
      const send = ctx.createGain();
      send.gain.value = opts.send;
      panner.connect(send);
      send.connect(this.extraSend);
      carrier.addEventListener('ended', () => safeDisconnect(send), { once: true });
    }

    mod.start(when);
    mod.stop(end + 0.02);
    carrier.start(when);
    carrier.stop(end + 0.02);
    carrier.addEventListener(
      'ended',
      () => {
        safeDisconnect(carrier);
        safeDisconnect(mod);
        safeDisconnect(modGain);
        safeDisconnect(amp);
        safeDisconnect(panner);
      },
      { once: true },
    );
  }

  /** A sparse struck bell on a chord tone, two octaves up. */
  private bell(when: number): void {
    const step = anchorToChord(
      Math.floor(range(this.rng, 0, 8)),
      this.mode,
      this.degree(),
    );
    this.fmStrike({
      when,
      freq: this.freq(ladderSemis(this.mode, step) + 24),
      ratio: pick(this.rng, BELL_RATIOS),
      index: range(this.rng, 2.5, 6),
      modDecay: range(this.rng, 0.1, 0.2),
      decay: range(this.rng, 2.5, 4),
      gain: range(this.rng, 0.03, 0.055),
      pan: range(this.rng, -0.6, 0.6),
      send: 0.7,
    });
  }

  /**
   * Restate the theme. One variation operator per outing (and now and then
   * the plain theme), so it stays the same tune without ever repeating.
   * Returns the phrase length in seconds.
   */
  private phrase(when: number): number {
    const notes =
      this.rng() < 0.2 ? this.motif.map((n) => ({ ...n })) : varyMotif(this.motif, this.rng);
    if (notes.length === 0) return 1;

    const beat = range(this.rng, 0.55, 0.85);
    const degree = this.degree();
    const pan = range(this.rng, -0.3, 0.3);
    let t = when;

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]!;
      // Ground the phrase by pulling its outer notes onto the chord.
      const step =
        i === 0 || i === notes.length - 1
          ? anchorToChord(note.step, this.mode, degree)
          : note.step;
      const dur = note.dur * beat;
      this.fmStrike({
        when: t,
        freq: this.freq(ladderSemis(this.mode, step) + 12),
        ratio: 2.01,
        index: range(this.rng, 1.2, 2.4),
        modDecay: range(this.rng, 0.06, 0.12),
        decay: Math.max(1.2, dur * 2.4),
        gain: range(this.rng, 0.055, 0.08),
        pan: pan + range(this.rng, -0.12, 0.12),
        send: 0.85,
      });
      t += dur;
    }
    return t - when;
  }

  /** Low swell under everything — the old mix had no weight below the pad. */
  private subSwell(when: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const attack = range(this.rng, 7, 11);
    const release = range(this.rng, 10, 16);
    const end = when + attack + release;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = this.freq(chordTones(this.mode, this.degree(), 1)[0]! - 24);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 120;
    filter.Q.value = 0.4;

    const g = ctx.createGain();
    const peak = 0.05 + this.intensity * 0.03;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.linearRampToValueAtTime(0.0001, end);

    osc.connect(filter);
    filter.connect(g);
    g.connect(bus);
    osc.start(when);
    osc.stop(end + 0.05);
    osc.addEventListener(
      'ended',
      () => {
        safeDisconnect(osc);
        safeDisconnect(filter);
        safeDisconnect(g);
      },
      { once: true },
    );
  }

  // ------------------------------------------------------------------ mixing

  /** Pull the music back for a moment so an effect can land. */
  private duck(amount = 0.55, recover = 0.8): void {
    if (!this.musicOut || !this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.musicOut.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(MUSIC_GAIN * amount, now + 0.05);
    g.linearRampToValueAtTime(MUSIC_GAIN, now + recover);
  }

  // -------------------------------------------------------------------- SFX

  private tone(opts: {
    freq: number;
    dur: number;
    type?: OscillatorType | 'warm';
    gain?: number;
    attack?: number;
    delay?: number;
    slideTo?: number;
    detune?: number;
    pan?: number;
    filterFreq?: number;
    send?: number;
  }): void {
    const ctx = this.ctx;
    const dest = this.sfx;
    if (!ctx || !dest) return;
    const now = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    if (opts.type === 'warm' && this.warm) osc.setPeriodicWave(this.warm);
    else osc.type = opts.type === 'warm' ? 'sine' : (opts.type ?? 'sine');
    osc.frequency.setValueAtTime(opts.freq, now);
    if (opts.slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, opts.slideTo),
        now + opts.dur * 0.85,
      );
    }
    if (opts.detune) osc.detune.value = opts.detune;

    let node: AudioNode = osc;
    if (opts.filterFreq) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.filterFreq;
      f.Q.value = 0.8;
      osc.connect(f);
      node = f;
    }

    const g = ctx.createGain();
    const amp = opts.gain ?? 0.08;
    const attack = Math.min(opts.attack ?? 0.012, opts.dur * 0.4);
    g.gain.setValueAtTime(0.0001, now);
    if (attack > 0.08) g.gain.linearRampToValueAtTime(amp, now + attack);
    else g.gain.exponentialRampToValueAtTime(amp, now + Math.max(0.008, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, now + opts.dur);

    const p = ctx.createStereoPanner();
    p.pan.value = clampPan(opts.pan ?? 0);
    node.connect(g);
    g.connect(p);
    p.connect(dest);
    if (this.sfxSend && (opts.send ?? 0) > 0) {
      const send = ctx.createGain();
      send.gain.value = opts.send!;
      p.connect(send);
      send.connect(this.sfxSend);
      osc.addEventListener('ended', () => safeDisconnect(send), { once: true });
    }

    osc.start(now);
    osc.stop(now + opts.dur + 0.02);
    osc.addEventListener('ended', () => safeDisconnect(p), { once: true });
  }

  private noiseBurst(opts: {
    dur: number;
    gain: number;
    filterType?: BiquadFilterType;
    filterFreq?: number;
    filterTo?: number;
    q?: number;
    delay?: number;
    pan?: number;
    send?: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.noise) return;
    const now = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = opts.filterType ?? 'bandpass';
    f.frequency.setValueAtTime(opts.filterFreq ?? 900, now);
    if (opts.filterTo !== undefined) {
      f.frequency.exponentialRampToValueAtTime(opts.filterTo, now + opts.dur);
    }
    f.Q.value = opts.q ?? 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(opts.gain, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + opts.dur);
    const p = ctx.createStereoPanner();
    p.pan.value = clampPan(opts.pan ?? 0);
    src.connect(f);
    f.connect(g);
    g.connect(p);
    p.connect(this.sfx);
    if (this.sfxSend && (opts.send ?? 0) > 0) {
      const send = ctx.createGain();
      send.gain.value = opts.send!;
      p.connect(send);
      send.connect(this.sfxSend);
      src.addEventListener('ended', () => safeDisconnect(send), { once: true });
    }
    src.start(now, Math.random() * 1.4);
    src.stop(now + opts.dur + 0.02);
    src.addEventListener(
      'ended',
      () => {
        safeDisconnect(src);
        safeDisconnect(f);
        safeDisconnect(g);
        safeDisconnect(p);
      },
      { once: true },
    );
  }

  plant(kind: TreeKind = 'dyson', pan = 0): void {
    this.whenRunning(() => this.plantNow(kind, pan));
  }

  private plantNow(kind: TreeKind, pan: number): void {
    // Plant on chord tones so it lands inside the current harmony.
    const shift = kind === 'energy' ? 1 : kind === 'defense' ? -1 : 0;
    const tones = chordTones(this.mode, this.degree(), 3);
    for (let i = 0; i < tones.length; i++) {
      this.tone({
        freq: this.freq(tones[i]! + 12 + shift * 12),
        dur: 0.6,
        type: 'sine',
        gain: 0.07,
        attack: 0.018,
        delay: i * 0.06,
        pan,
        send: 0.4,
      });
    }
    this.noiseBurst({
      dur: 0.09,
      gain: 0.035,
      filterType: 'lowpass',
      filterFreq: 900,
      q: 0.6,
      pan,
      send: 0.25,
    });
  }

  send(count = 1, pan = 0): void {
    this.whenRunning(() => this.sendNow(count, pan));
  }

  private sendNow(count: number, pan: number): void {
    const intensity = Math.min(1.1, 0.5 + Math.log2(1 + count) * 0.16);
    this.noiseBurst({
      dur: 0.24,
      gain: 0.06 * intensity,
      filterType: 'bandpass',
      filterFreq: 380,
      filterTo: 1800,
      q: 1.0,
      pan,
      send: 0.3,
    });
    this.tone({
      freq: 320,
      slideTo: 540,
      dur: 0.18,
      type: 'sine',
      gain: 0.04 * intensity,
      attack: 0.012,
      pan,
      send: 0.25,
    });
  }

  capture(pan = 0): void {
    this.whenRunning(() => {
      const t = performance.now();
      if (t - this.lastCaptureAt < 250) return;
      this.lastCaptureAt = t;
      this.captureNow(pan);
    });
  }

  private captureNow(pan: number): void {
    // An arpeggio up the current chord — a capture should sound like the
    // music agreeing with you, not like a separate beep.
    const tones = chordTones(this.mode, this.degree(), 4);
    for (let i = 0; i < tones.length; i++) {
      this.tone({
        freq: this.freq(tones[i]! + 12),
        dur: 0.8,
        type: 'sine',
        gain: 0.065,
        attack: 0.025,
        delay: i * 0.08,
        pan,
        send: 0.6,
      });
    }
    this.tone({
      freq: this.freq(tones[0]!),
      dur: 1.6,
      type: 'warm',
      gain: 0.035,
      attack: 0.14,
      pan: pan * 0.5,
      send: 0.5,
    });
  }

  clash(pan = 0): void {
    this.whenRunning(() => {
      const t = performance.now();
      if (t - this.lastClashAt < 180) return;
      this.lastClashAt = t;
      this.clashNow(pan);
    });
  }

  private clashNow(pan: number): void {
    this.duck(0.72, 0.6);
    this.noiseBurst({
      dur: 0.15,
      gain: 0.085,
      filterType: 'bandpass',
      filterFreq: 520 * range(this.rng, 0.9, 1.15),
      filterTo: 1100,
      q: 1.4,
      pan,
      send: 0.35,
    });
  }

  death(pan = 0): void {
    this.whenRunning(() => {
      const t = performance.now();
      if (t - this.lastDeathAt < 90) return;
      this.lastDeathAt = t;
      this.deathNow(pan);
    });
  }

  private deathNow(pan: number): void {
    // Randomise pitch and timing a touch — a wave of deaths used to fire as
    // one machine-gun burst of identical clicks.
    const jitter = range(this.rng, 0.88, 1.14);
    this.tone({
      freq: 200 * jitter,
      slideTo: 64,
      dur: 0.6,
      type: 'sine',
      gain: 0.055,
      attack: 0.02,
      filterFreq: 500,
      delay: range(this.rng, 0, 0.03),
      pan,
      send: 0.4,
    });
    this.noiseBurst({
      dur: 0.2,
      gain: 0.04,
      filterType: 'lowpass',
      filterFreq: 480,
      q: 0.5,
      pan,
      send: 0.3,
    });
  }

  burn(pan = 0): void {
    this.whenRunning(() => {
      const t = performance.now();
      if (t - this.lastBurnAt < 400) return;
      this.lastBurnAt = t;
      this.burnNow(pan);
    });
  }

  private burnNow(pan: number): void {
    this.duck(0.6, 1.1);
    this.tone({
      freq: 64,
      dur: 0.6,
      type: 'sine',
      gain: 0.055,
      attack: 0.04,
      filterFreq: 180,
      pan: pan * 0.4,
      send: 0.2,
    });
    this.noiseBurst({
      dur: 0.5,
      gain: 0.06,
      filterType: 'lowpass',
      filterFreq: 420,
      filterTo: 160,
      q: 0.5,
      pan,
      send: 0.4,
    });
    for (let i = 0; i < 5; i++) {
      this.noiseBurst({
        dur: 0.05,
        gain: 0.038,
        filterType: 'highpass',
        filterFreq: 1800,
        q: 0.8,
        delay: 0.04 + i * 0.07,
        pan: clampPan(pan + range(this.rng, -0.4, 0.4)),
        send: 0.5,
      });
    }
  }

  fail(pan = 0): void {
    this.whenRunning(() => this.failNow(pan));
  }

  private failNow(pan: number): void {
    const tones = chordTones(this.mode, this.degree(), 3);
    this.tone({
      freq: this.freq(tones[1]!),
      dur: 0.16,
      type: 'sine',
      gain: 0.055,
      filterFreq: 1200,
      pan,
      send: 0.2,
    });
    this.tone({
      freq: this.freq(tones[0]!),
      dur: 0.24,
      type: 'triangle',
      gain: 0.04,
      delay: 0.07,
      filterFreq: 1000,
      pan,
      send: 0.2,
    });
  }

  win(): void {
    this.mood = 'won';
    this.whenRunning(() => {
      this.mode = moodMode(this.mode, 'won');
      this.transitionBed(1.05, 1.25);
      // A last statement of the theme, up an octave, in the brightened mode.
      const notes = this.motif;
      let t = this.ctx!.currentTime + 0.15;
      for (const note of notes) {
        this.fmStrike({
          when: t,
          freq: this.freq(ladderSemis(this.mode, note.step) + 24),
          ratio: 2.01,
          index: 2,
          modDecay: 0.1,
          decay: 1.8,
          gain: 0.085,
          pan: range(this.rng, -0.25, 0.25),
          send: 0.9,
        });
        t += note.dur * 0.5;
      }
      for (const s of chordTones(this.mode, 0, 4)) {
        this.tone({
          freq: this.freq(s),
          dur: 2.4,
          type: 'warm',
          gain: 0.045,
          attack: 0.2,
          send: 0.6,
        });
      }
    });
  }

  lose(): void {
    this.mood = 'lost';
    this.whenRunning(() => {
      this.mode = moodMode(this.mode, 'lost');
      this.transitionBed(0.7, 0.5);
      // The theme sinking: same shape, each restatement lower and slower.
      const notes = this.motif;
      let t = this.ctx!.currentTime + 0.15;
      for (let i = 0; i < notes.length; i++) {
        this.fmStrike({
          when: t,
          freq: this.freq(ladderSemis(this.mode, notes[i]!.step - i)),
          ratio: 2.01,
          index: 1.4,
          modDecay: 0.14,
          decay: 2.6,
          gain: 0.06,
          pan: range(this.rng, -0.2, 0.2),
          send: 0.8,
        });
        t += notes[i]!.dur * 0.9;
      }
    });
  }

  /** Move the bed's dry/wet balance for the win/lose moods, over 8 s. */
  private transitionBed(dryMul: number, wetMul: number): void {
    if (!this.ctx || !this.dryGain || !this.wetGain) return;
    const now = this.ctx.currentTime;
    this.dryGain.gain.cancelScheduledValues(now);
    this.dryGain.gain.setValueAtTime(this.dryGain.gain.value, now);
    this.dryGain.gain.linearRampToValueAtTime(0.62 * dryMul, now + 8);
    this.wetGain.gain.cancelScheduledValues(now);
    this.wetGain.gain.setValueAtTime(this.wetGain.gain.value, now);
    this.wetGain.gain.linearRampToValueAtTime(0.5 * wetMul, now + 8);
  }
}

function clampPan(pan: number): number {
  return Math.max(-1, Math.min(1, pan));
}

function safeDisconnect(node: AudioNode | null | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* already disconnected */
  }
}

function makeWarmWave(ctx: AudioContext): PeriodicWave {
  const real = new Float32Array([0, 1, 0.18, 0.08, 0.03, 0.015]);
  const imag = new Float32Array(real.length);
  return ctx.createPeriodicWave(real, imag);
}
