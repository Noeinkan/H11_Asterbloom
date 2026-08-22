import { describe, expect, it } from 'vitest';
import { sendSeedlings } from '../../src/game/sim/commands';
import {
  ORBIT_BASE_SPEED,
  ORBIT_RETROGRADE_CUT,
  ORBIT_SPEED_SPREAD,
} from '../../src/game/sim/types';
import {
  addAsteroid,
  createEmptyWorld,
  spawnOrbiters,
  tick,
} from '../../src/game/sim/world';

const DT = 1 / 60;

function orbitWorld(seed = 11, count = 24) {
  const world = createEmptyWorld(seed);
  const rock = addAsteroid(world, {
    x: 0,
    y: 0,
    travelRadius: 400,
    owner: 'player',
  });
  spawnOrbiters(world, rock.id, 'player', count);
  return { world, rock };
}

function relativeAngle(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(ay, ax) - Math.atan2(by, bx);
}

describe('seedling orbit motion', () => {
  it('gives every orbiter its own angular rate', () => {
    const { world } = orbitWorld();
    const speeds = [...world.seedlings.values()].map((s) => s.orbitSpeed);
    expect(new Set(speeds.map((v) => v.toFixed(6))).size).toBe(speeds.length);
  });

  it('keeps per-seed rates inside the configured spread of the base rate', () => {
    const { world, rock } = orbitWorld();
    const base = ORBIT_BASE_SPEED + rock.stats.speed / 560;
    const rates = [...world.seedlings.values()].map((s) => Math.abs(s.orbitSpeed));
    for (const r of rates) {
      expect(Math.abs(r - base) / base).toBeLessThanOrEqual(
        ORBIT_SPEED_SPREAD + 1e-9,
      );
    }
    const spread = Math.max(...rates) - Math.min(...rates);
    expect(spread).toBeGreaterThan(base * ORBIT_SPEED_SPREAD);
  });

  it('turns a minority of a flock retrograde', () => {
    const { world } = orbitWorld();
    const all = [...world.seedlings.values()];
    const retro = all.filter((s) => s.orbitSpeed < 0);
    expect(retro.length).toBeGreaterThan(0);
    expect(retro.length).toBeLessThan(all.length / 2);
  });

  it('shears the ring apart instead of rotating it rigidly', () => {
    const { world, rock } = orbitWorld();
    const all = [...world.seedlings.values()];
    const a = all[0]!;
    const b = all[1]!;
    const before = relativeAngle(
      a.x - rock.x,
      a.y - rock.y,
      b.x - rock.x,
      b.y - rock.y,
    );
    for (let i = 0; i < 600; i++) tick(world, DT);
    const after = relativeAngle(
      a.x - rock.x,
      a.y - rock.y,
      b.x - rock.x,
      b.y - rock.y,
    );
    expect(Math.abs(after - before)).toBeGreaterThan(0.2);
  });

  it('desynchronises the breeze bob across a flock', () => {
    const { world } = orbitWorld();
    for (let i = 0; i < 300; i++) tick(world, DT);
    const zs = [...world.seedlings.values()].map((s) => s.z);
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    const spread = Math.sqrt(
      zs.reduce((acc, z) => acc + (z - mean) ** 2, 0) / zs.length,
    );
    expect(spread).toBeGreaterThan(1);
  });

  it('retrograde orbiters face the way they travel', () => {
    const { world, rock } = orbitWorld();
    const retro = [...world.seedlings.values()].find((s) => s.orbitSpeed < 0);
    expect(retro).toBeDefined();
    const s = retro!;
    const before = Math.atan2(s.y - rock.y, s.x - rock.x);
    for (let i = 0; i < 30; i++) tick(world, DT);
    const after = Math.atan2(s.y - rock.y, s.x - rock.x);
    let delta = after - before;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    expect(delta).toBeLessThan(0);
  });

  it('keeps a seedling its own rate after a trip to another rock', () => {
    const world = createEmptyWorld(5);
    const home = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 400,
      owner: 'player',
    });
    const away = addAsteroid(world, {
      x: 260,
      y: 0,
      travelRadius: 400,
      owner: 'neutral',
    });
    spawnOrbiters(world, home.id, 'player', 12);
    const speeds = new Map(
      [...world.seedlings.values()].map((s) => [s.id, s.orbitSpeed]),
    );
    expect(sendSeedlings(world, home.id, away.id, 12, 'player').ok).toBe(true);
    for (let i = 0; i < 900; i++) tick(world, DT);
    const arrived = [...world.seedlings.values()].filter(
      (s) => s.asteroidId === away.id && s.state === 'orbit',
    );
    expect(arrived.length).toBeGreaterThan(0);
    for (const s of arrived) {
      expect(s.orbitSpeed).toBeCloseTo(speeds.get(s.id)!, 10);
    }
    expect(new Set(arrived.map((s) => s.orbitSpeed.toFixed(6))).size).toBe(
      arrived.length,
    );
  });
});

describe('orbit constants', () => {
  it('cuts retrograde from the tail of the variance range', () => {
    expect(ORBIT_RETROGRADE_CUT).toBeGreaterThan(-1);
    expect(ORBIT_RETROGRADE_CUT).toBeLessThan(0);
  });
});
