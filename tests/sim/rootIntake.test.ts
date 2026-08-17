import { describe, expect, it } from 'vitest';
import {
  buildAdultTree,
  coreSeekingStrokes,
} from '../../src/game/sim/lsystem';
import {
  POCKET_REGEN_PER_SEC,
  CORE_ENERGY_PER_INTAKE,
  CORE_FEED_DRAIN,
  treeVisualScale,
  type ResourcePocket,
} from '../../src/game/sim/types';
import {
  addAsteroid,
  computeRootIntake,
  createEmptyWorld,
  plantPose,
  tick,
} from '../../src/game/sim/world';

function pocket(
  kind: ResourcePocket['kind'],
  angle: number,
  radiusT: number,
  amount = 14,
): ResourcePocket {
  return {
    id: 0,
    kind,
    amount,
    maxAmount: amount,
    angle,
    radiusT,
    depthT: 0.1,
    regenPerSec: POCKET_REGEN_PER_SEC,
    depletedAt: null,
    phase: 0,
  };
}

/** World-space positions of one tree's baked root tips (same math as sim). */
function rootTips(
  asteroid: ReturnType<typeof addAsteroid>,
  treeSeed: number,
  slotIndex: number,
): { x: number; y: number }[] {
  const scale = treeVisualScale(asteroid.radius, asteroid.seed);
  const pose = plantPose(asteroid, slotIndex);
  const adult = buildAdultTree(
    treeSeed,
    scale,
    pose.dist,
    pose.surfaceY,
    'dyson',
  );
  const tips: { x: number; y: number }[] = [];
  const rot = pose.angle + Math.PI / 2;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (const stroke of coreSeekingStrokes(adult)) {
    const tip = stroke.points[stroke.points.length - 1];
    if (!tip) continue;
    const dx = tip.x * cos - tip.y * sin;
    const dy = tip.x * sin + tip.y * cos;
    tips.push({ x: pose.x - asteroid.x + dx, y: pose.y - asteroid.y + dy });
  }
  return tips;
}

describe('computeRootIntake', () => {
  it('returns zero when there are no pockets', () => {
    const world = createEmptyWorld(1);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      pockets: [],
    });
    const intake = computeRootIntake(rock, 12345, 0, 'dyson');
    expect(intake).toEqual({ mineral: 0, water: 0, energy: 0 });
  });

  it('returns zero while every pocket is depleted', () => {
    const world = createEmptyWorld(2);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      pockets: [
        { ...pocket('mineral', 0, 0.5, 0), depletedAt: 1 },
        { ...pocket('water', 1, 0.5, 0), depletedAt: 1 },
      ],
    });
    expect(computeRootIntake(rock, 12345, 0, 'dyson')).toEqual({
      mineral: 0,
      water: 0,
      energy: 0,
    });
  });

  it('rewards a root tip closer to a pocket (distance monotonicity)', () => {
    const seed = 7;
    const world = createEmptyWorld(3);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      pockets: [],
    });
    const tips = rootTips(rock, seed, 0);
    expect(tips.length).toBeGreaterThan(0);
    const tip = tips[0]!;
    const angle = Math.atan2(tip.y, tip.x);
    const radiusT = Math.hypot(tip.x, tip.y) / rock.radius;

    const near = computeRootIntake(
      { ...rock, pockets: [pocket('mineral', angle, radiusT)] },
      seed,
      0,
      'dyson',
    );
    // Same bearing but 2x radius: beyond the falloff of every root tip.
    const far = computeRootIntake(
      { ...rock, pockets: [pocket('mineral', angle, 2.0)] },
      seed,
      0,
      'dyson',
    );
    expect(near.mineral).toBeGreaterThan(0);
    expect(far.mineral).toBe(0);
    expect(near.mineral).toBeGreaterThan(far.mineral);
  });

  it('sums each kind independently across mixed pockets', () => {
    const seed = 11;
    const world = createEmptyWorld(4);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      pockets: [],
    });
    const tip = rootTips(rock, seed, 0)[0]!;
    const angle = Math.atan2(tip.y, tip.x);
    const radiusT = Math.hypot(tip.x, tip.y) / rock.radius;

    const mineral = pocket('mineral', angle, radiusT, 14);
    const water = pocket('water', angle, radiusT, 12);
    const energy = pocket('energy', angle, radiusT, 10);
    const intake = computeRootIntake(
      { ...rock, pockets: [mineral, water, energy] },
      seed,
      0,
      'dyson',
    );

    // Identical positions → each kind scales with its own amount.
    expect(intake.mineral).toBeGreaterThan(0);
    expect(intake.water).toBeGreaterThan(0);
    expect(intake.energy).toBeGreaterThan(0);
    expect(intake.mineral / 14).toBeCloseTo(intake.water / 12, 5);
    expect(intake.mineral / 14).toBeCloseTo(intake.energy / 10, 5);
  });
});

describe('coreEnergy dynamics', () => {
  function fedWorld(): { world: ReturnType<typeof createEmptyWorld>; rock: ReturnType<typeof addAsteroid> } {
    const world = createEmptyWorld(5);
    const seed = 13;
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      coreEnergy: 50,
      maxCoreEnergy: 100,
      pockets: [],
    });
    const tip = rootTips(rock, seed, 0)[0]!;
    const angle = Math.atan2(tip.y, tip.x);
    const radiusT = Math.hypot(tip.x, tip.y) / rock.radius;
    rock.pockets = [
      pocket('mineral', angle, radiusT, 14),
      pocket('water', angle, radiusT, 12),
      pocket('energy', angle, radiusT, 10),
    ];
    world.trees.set(1, {
      id: 1,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'dyson',
      seed,
      maturity: 1,
      faction: 'player',
      spawnAccumulator: 0,
      coreFeed: 1,
    });
    return { world, rock };
  }

  it('rises when intake exceeds drain', () => {
    const { world, rock } = fedWorld();
    const before = rock.coreEnergy;
    for (let i = 0; i < 60; i++) tick(world, 1 / 60);
    const intake = world.trees.get(1)!.rootIntake!;
    const gross =
      CORE_ENERGY_PER_INTAKE.mineral * intake.mineral +
      CORE_ENERGY_PER_INTAKE.water * intake.water +
      CORE_ENERGY_PER_INTAKE.energy * intake.energy;
    expect(gross).toBeGreaterThan(CORE_FEED_DRAIN);
    expect(rock.coreEnergy).toBeGreaterThan(before);
  });

  it('falls when intake is zero', () => {
    const world = createEmptyWorld(6);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      coreEnergy: 50,
      maxCoreEnergy: 100,
      pockets: [],
    });
    world.trees.set(1, {
      id: 1,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'dyson',
      seed: 99,
      maturity: 1,
      faction: 'player',
      spawnAccumulator: 0,
      coreFeed: 1,
    });
    const before = rock.coreEnergy;
    for (let i = 0; i < 60; i++) tick(world, 1 / 60);
    expect(rock.coreEnergy).toBeLessThan(before);
  });
});
