/**
 * Smoke test for the scheduler, against a minimal Web Audio mock.
 *
 * Worth the mock: `pump()` advances its cursors inside `while` loops, so a
 * bad period would hang the browser rather than merely sound wrong, and a NaN
 * frequency silently kills a voice with no error anywhere. Neither shows up in
 * the pure `theory` tests.
 */
import { describe, expect, it, vi } from 'vitest';

let now = 0;
const startedFreqs: number[] = [];
let oscCount = 0;

function param(initial = 0) {
  const p = {
    value: initial,
    setValueAtTime: vi.fn((v: number) => {
      if (!Number.isFinite(v)) throw new Error('setValueAtTime NaN');
      p.value = v;
      return p;
    }),
    linearRampToValueAtTime: vi.fn((v: number, t: number) => {
      if (!Number.isFinite(v) || !Number.isFinite(t)) throw new Error('linear ramp NaN');
      return p;
    }),
    exponentialRampToValueAtTime: vi.fn((v: number, t: number) => {
      if (!Number.isFinite(v) || !Number.isFinite(t)) throw new Error('exp ramp NaN');
      // The real API throws on a zero or negative target.
      if (v <= 0) throw new Error('exponentialRamp to non-positive value');
      return p;
    }),
    setTargetAtTime: vi.fn((v: number) => {
      if (!Number.isFinite(v)) throw new Error('setTargetAtTime NaN');
      return p;
    }),
    cancelScheduledValues: vi.fn(() => p),
  };
  return p;
}

function node(extra: Record<string, unknown> = {}) {
  return { connect: vi.fn(), disconnect: vi.fn(), addEventListener: vi.fn(), ...extra };
}

class MockCtx {
  sampleRate = 44100;
  state = 'running';
  destination = node();
  get currentTime() {
    return now;
  }
  createGain() {
    return node({ gain: param(1) });
  }
  createOscillator() {
    oscCount += 1;
    const frequency = param(440);
    return node({
      type: 'sine',
      frequency,
      detune: param(0),
      start: vi.fn((t: number) => {
        if (!Number.isFinite(t)) throw new Error('start() NaN');
        startedFreqs.push(frequency.value);
      }),
      stop: vi.fn((t: number) => {
        if (!Number.isFinite(t)) throw new Error('stop() NaN');
      }),
      setPeriodicWave: vi.fn(),
    });
  }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: param(1000), Q: param(1) });
  }
  createStereoPanner() {
    return node({ pan: param(0) });
  }
  createDelay() {
    return node({ delayTime: param(0) });
  }
  createConvolver() {
    return node({ buffer: null });
  }
  createDynamicsCompressor() {
    return node({
      threshold: param(0),
      knee: param(0),
      ratio: param(1),
      attack: param(0),
      release: param(0),
    });
  }
  createBufferSource() {
    return node({ buffer: null, start: vi.fn(), stop: vi.fn() });
  }
  createBuffer(channels: number, length: number) {
    return { numberOfChannels: channels, length, copyToChannel: vi.fn() };
  }
  createPeriodicWave() {
    return {};
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
}

async function runEngine() {
  now = 0;
  oscCount = 0;
  startedFreqs.length = 0;
  vi.stubGlobal('AudioContext', MockCtx);
  vi.stubGlobal('window', {
    AudioContext: MockCtx,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  vi.stubGlobal('document', { addEventListener: () => {}, hidden: false });
  vi.stubGlobal('performance', { now: () => now * 1000 });

  const { GameAudio } = await import('../../src/game/audio/audio');
  const audio = new GameAudio();
  audio.beginMatch(200, true, 12345);
  audio.startAmbient();
  return { audio, engine: audio as unknown as { pump(): void } };
}

describe('scheduler', () => {
  it('keeps producing finite, audible events over a long match', async () => {
    const { audio, engine } = await runEngine();
    const steps = 10 * 60 * 5; // ten minutes at 0.2 s
    for (let i = 0; i < steps; i++) {
      now += 0.2;
      engine.pump();
      if (i % 250 === 0) audio.setIntensity((i / steps) % 1);
    }

    // Roughly one voice a second — dense enough to be music, sparse enough
    // not to be a CPU problem.
    expect(oscCount).toBeGreaterThan(300);
    expect(oscCount).toBeLessThan(3000);

    for (const f of startedFreqs) expect(Number.isFinite(f)).toBe(true);
    // Only the two delay-drift LFOs run below audio rate.
    expect(startedFreqs.filter((f) => f < 15)).toHaveLength(2);
    for (const f of startedFreqs.filter((f) => f >= 15)) {
      expect(f).toBeGreaterThan(20);
      expect(f).toBeLessThan(20000);
    }
  });

  it('survives the whole surface being poked while it plays', async () => {
    const { audio, engine } = await runEngine();
    for (let i = 0; i < 400; i++) {
      now += 0.2;
      engine.pump();
      audio.setAtmosphere((i * 7) % 360, i % 3 === 0);
      audio.setIntensity((i % 20) / 20);
      if (i % 5 === 0) audio.plant('energy', -0.4);
      if (i % 7 === 0) audio.send(i % 12, 0.3);
      if (i % 11 === 0) audio.capture(0.1);
      if (i % 3 === 0) audio.clash(-0.2);
      if (i % 4 === 0) audio.death(0.5);
      if (i % 13 === 0) audio.burn(0);
      if (i % 17 === 0) audio.fail(0);
    }
    audio.win();
    audio.lose();
    for (const f of startedFreqs) {
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThan(0);
    }
    expect(oscCount).toBeGreaterThan(100);
  });
});
