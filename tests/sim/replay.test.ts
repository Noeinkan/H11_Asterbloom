import { describe, expect, it } from 'vitest';
import { tickAi } from '../../src/game/sim/ai';
import {
  plantOnCrustAngle,
  sendSeedlings,
} from '../../src/game/sim/commands';
import {
  createMatchRuntime,
  tickMatchRuntime,
  type MatchConfig,
  type MatchRuntime,
} from '../../src/game/sim/match';
import {
  createReplayLog,
  decodeReplay,
  encodeReplay,
  recordPlant,
  recordSend,
  replay,
  REPLAY_SCHEMA_VERSION,
  startWorldFor,
  type ReplayLog,
  type ReplayStart,
} from '../../src/game/sim/replay';
import { worldDigest } from '../../src/game/sim/serialize';
import { SIM_DT, type World } from '../../src/game/sim/types';
import { tick } from '../../src/game/sim/world';

/**
 * A replay is a seed plus the player's commands. That only works because the
 * rival is deterministic — `tickAi` has no RNG at all — and because every
 * simulation RNG is derived from world and entity state rather than a stream.
 *
 * The two tests that carry weight here are the empty-log determinism check
 * (proving `tick` + `tickAi` really are reproducible) and the negative
 * control (proving the recorded commands are load-bearing, and the sim is not
 * just converging to the same place regardless).
 */

const SKIRMISH: ReplayStart = {
  mode: 'skirmish',
  seed: 0xc0a1f00d,
  difficulty: 'normal',
};

function step(
  world: World,
  config: MatchConfig,
  runtime: MatchRuntime,
  steps: number,
): void {
  for (let i = 0; i < steps; i++) {
    tick(world, SIM_DT);
    tickAi(world, SIM_DT);
    tickMatchRuntime(world, config, runtime, SIM_DT);
  }
}

describe('replay determinism', () => {
  it('reproduces a command-free match exactly', () => {
    const log = createReplayLog(SKIRMISH);
    const a = replay(log, 1800);
    const b = replay(log, 1800);
    expect(worldDigest(a.world)).toBe(worldDigest(b.world));
    // Guard against a vacuous pass: the match must actually have progressed.
    expect(a.world.time).toBeGreaterThan(25);
    expect(a.world.seedlings.size).toBeGreaterThan(0);
  });

  it('reproduces an authored campaign map', () => {
    const log = createReplayLog({ mode: 'campaign', index: 3 });
    expect(worldDigest(replay(log, 1200).world)).toBe(
      worldDigest(replay(log, 1200).world),
    );
  });

  it('reproduces a hard skirmish, where the AI thinks on a different beat', () => {
    const log = createReplayLog({
      mode: 'skirmish',
      seed: 0x51de5eed,
      difficulty: 'hard',
    });
    expect(worldDigest(replay(log, 1200).world)).toBe(
      worldDigest(replay(log, 1200).world),
    );
  });

  it('gives different difficulties different matches', () => {
    const easy = replay(
      createReplayLog({ mode: 'skirmish', seed: 0xc0a1f00d, difficulty: 'easy' }),
      1200,
    );
    const hard = replay(
      createReplayLog({ mode: 'skirmish', seed: 0xc0a1f00d, difficulty: 'hard' }),
      1200,
    );
    expect(worldDigest(easy.world)).not.toBe(worldDigest(hard.world));
  });

  it('rebuilds the same starting world every time', () => {
    expect(worldDigest(startWorldFor(SKIRMISH).world)).toBe(
      worldDigest(startWorldFor(SKIRMISH).world),
    );
  });
});

/**
 * The recorder contract: driving the world by hand and replaying the log of
 * what was done must land on the same state. If this drifts, the log is
 * recording the wrong thing — most likely a resolved outcome rather than the
 * player's input.
 */
describe('recorded commands', () => {
  /** Two rocks the player can legally send between, at a given moment. */
  function playerRoute(world: World): { from: number; to: number } | null {
    for (const a of world.asteroids.values()) {
      if (a.owner !== 'player') continue;
      for (const b of world.asteroids.values()) {
        if (b.id === a.id) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d <= a.travelRadius) return { from: a.id, to: b.id };
      }
    }
    return null;
  }

  function driveManually(): { world: World; log: ReplayLog } {
    const { world, config } = startWorldFor(SKIRMISH);
    const runtime = createMatchRuntime();
    const log = createReplayLog(SKIRMISH);

    step(world, config, runtime, 300);
    const route = playerRoute(world)!;
    expect(route).not.toBeNull();
    const sent = sendSeedlings(world, route.from, route.to, 8, 'player');
    expect(sent.ok).toBe(true);
    recordSend(log, 300, route.from, route.to, 8);

    step(world, config, runtime, 200);
    const home = [...world.asteroids.values()].find(
      (a) => a.owner === 'player',
    )!;
    const planted = plantOnCrustAngle(world, home.id, 1.25, 'player', 'dyson');
    if (planted.ok) recordPlant(log, 500, home.id, 1.25, 'dyson');

    step(world, config, runtime, 400);
    return { world, log };
  }

  it('replays a hand-driven match to the same state', () => {
    const { world, log } = driveManually();
    expect(log.commands.length).toBeGreaterThan(0);
    const result = replay(log, 900);
    expect(worldDigest(result.world)).toBe(worldDigest(world));
  });

  it('drops a command and lands somewhere else', () => {
    // The negative control. Without it, the test above would still pass if
    // the sim ignored the log entirely.
    const { world, log } = driveManually();
    const trimmed: ReplayLog = {
      ...log,
      commands: log.commands.slice(1),
    };
    expect(worldDigest(replay(trimmed, 900).world)).not.toBe(
      worldDigest(world),
    );
  });

  it('is sensitive to when a command was issued', () => {
    const { log } = driveManually();
    const shifted: ReplayLog = {
      ...log,
      commands: log.commands.map((c) => ({ ...c, t: c.t + 60 })),
    };
    expect(worldDigest(replay(shifted, 900).world)).not.toBe(
      worldDigest(replay(log, 900).world),
    );
  });

  it('applies a command before the step it is stamped with', () => {
    // Recording happens between frames, so a command at tick t must land
    // before step t runs. One tick either way is a visible difference.
    const { log } = driveManually();
    const later: ReplayLog = {
      ...log,
      commands: log.commands.map((c) => ({ ...c, t: c.t + 1 })),
    };
    expect(worldDigest(replay(later, 900).world)).not.toBe(
      worldDigest(replay(log, 900).world),
    );
  });

  it('replays the same log twice identically', () => {
    const { log } = driveManually();
    expect(worldDigest(replay(log, 900).world)).toBe(
      worldDigest(replay(log, 900).world),
    );
  });
});

describe('replay encoding', () => {
  it('round-trips a log', () => {
    const log = createReplayLog(SKIRMISH);
    recordSend(log, 12, 1, 2, 5);
    recordPlant(log, 40, 3, 0.75, 'energy');
    const back = decodeReplay(encodeReplay(log))!;
    expect(back).toEqual(log);
  });

  it('replays a decoded log to the same state as the original', () => {
    const log = createReplayLog(SKIRMISH);
    recordSend(log, 100, 1, 2, 4);
    const back = decodeReplay(encodeReplay(log))!;
    expect(worldDigest(replay(back, 600).world)).toBe(
      worldDigest(replay(log, 600).world),
    );
  });

  it('rejects anything it cannot replay', () => {
    expect(decodeReplay('nope')).toBeNull();
    expect(decodeReplay('{}')).toBeNull();
    expect(decodeReplay('null')).toBeNull();
    expect(decodeReplay('[]')).toBeNull();

    const log = createReplayLog(SKIRMISH);
    const bumped = JSON.parse(encodeReplay(log));
    bumped.schema = REPLAY_SCHEMA_VERSION + 1;
    expect(decodeReplay(JSON.stringify(bumped))).toBeNull();

    const badMode = JSON.parse(encodeReplay(log));
    badMode.start = { mode: 'sandbox' };
    expect(decodeReplay(JSON.stringify(badMode))).toBeNull();

    const badCommand = JSON.parse(encodeReplay(log));
    badCommand.commands = [{ t: 1, k: 'detonate' }];
    expect(decodeReplay(JSON.stringify(badCommand))).toBeNull();

    const noTick = JSON.parse(encodeReplay(log));
    noTick.commands = [{ k: 'send', from: 1, to: 2, n: 3 }];
    expect(decodeReplay(JSON.stringify(noTick))).toBeNull();
  });

  it('accepts a campaign log', () => {
    const log = createReplayLog({ mode: 'campaign', index: 2 });
    expect(decodeReplay(encodeReplay(log))).toEqual(log);
  });
});
