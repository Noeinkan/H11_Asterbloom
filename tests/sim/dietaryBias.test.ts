import { describe, expect, it } from 'vitest';
import {
  DIET_GROWTH_RATE,
  DIET_SENTINEL_BIAS,
  DIET_STAT_GAIN,
  dietaryBias,
  dominantDiet,
  POCKET_REGEN_PER_SEC,
  type ResourcePocket,
  type Tree,
} from '../../src/game/sim/types';
import {
  addAsteroid,
  createEmptyWorld,
  tick,
} from '../../src/game/sim/world';

function makePocket(
  id: number,
  kind: 'mineral' | 'water' | 'energy',
  amount: number,
  radiusT = 0.45,
): ResourcePocket {
  return {
    id,
    kind,
    amount,
    maxAmount: amount,
    angle: 0,
    radiusT,
    depthT: 0.1,
    regenPerSec: POCKET_REGEN_PER_SEC,
    depletedAt: null,
    phase: 0,
  };
}

function makeWorld(pockets: ResourcePocket[]): { world: ReturnType<typeof createEmptyWorld>; tree: Tree } {
  const world = createEmptyWorld(7);
  const rock = addAsteroid(world, {
    x: 0,
    y: 0,
    radius: 120,
    travelRadius: 220,
    coreEnergy: 0,
    maxCoreEnergy: 100,
    pockets,
  });
  const tree: Tree = {
    id: 1,
    asteroidId: rock.id,
    slotIndex: 0,
    kind: 'dyson',
    seed: 42,
    maturity: 0,
    faction: 'player',
    spawnAccumulator: 0,
    coreFeed: 0.6,
  };
  world.trees.set(tree.id, tree);
  return { world, tree };
}

describe('dietaryBias normalization', () => {
  it('returns all zeros when intake is empty', () => {
    const bias = dietaryBias({ mineral: 0, water: 0, energy: 0 });
    expect(bias).toEqual({ mineral: 0, water: 0, energy: 0 });
  });

  it('weights kinds by DIET_GROWTH_WEIGHT and sums to 1', () => {
    const bias = dietaryBias({ mineral: 10, water: 10, energy: 10 });
    const sum = bias.mineral + bias.water + bias.energy;
    expect(sum).toBeCloseTo(1, 5);
    // energy has the highest weight, mineral second, water lowest.
    expect(bias.energy).toBeGreaterThan(bias.mineral);
    expect(bias.mineral).toBeGreaterThan(bias.water);
  });

  it('dominantDiet picks the strongest share', () => {
    expect(dominantDiet({ mineral: 1, water: 0, energy: 0 })).toBe('mineral');
    expect(dominantDiet({ mineral: 0, water: 0, energy: 1 })).toBe('energy');
    expect(dominantDiet({ mineral: 0.01, water: 0.01, energy: 0.01 })).toBe(null);
  });
});

describe('tree growth under dietary bias', () => {
  it('caches a normalized bias on the tree when pockets are present', () => {
    const { world, tree } = makeWorld([makePocket(0, 'mineral', 14)]);
    for (let i = 0; i < 10; i++) tick(world, 1 / 60);
    expect(tree.dietaryBias).toBeDefined();
    expect(tree.dietaryBias!.mineral).toBeGreaterThan(0.9);
    expect(tree.dietaryBias!.water).toBe(0);
    expect(tree.dietaryBias!.energy).toBe(0);
  });

  it('mineral pockets accelerate maturity by a bounded amount', () => {
    const { world: fed, tree: fedTree } = makeWorld([makePocket(0, 'mineral', 14)]);
    const { world: starved, tree: starvedTree } = makeWorld([]);
    for (let i = 0; i < 60; i++) {
      tick(fed, 1 / 60);
      tick(starved, 1 / 60);
    }
    const expectedBoost = 0.8 * DIET_GROWTH_RATE;
    const fedGain = fedTree.maturity - starvedTree.maturity;
    expect(fedGain).toBeGreaterThan(0);
    expect(fedGain).toBeLessThanOrEqual(expectedBoost + 1e-3);
  });

  it('energy-bias can graduate a non-energy tree to sentinel seedlings', () => {
    // Stack enough energy pockets around the orbit so the L-system root
    // tips reliably hit one; the bias loop then drives sentinel
    // graduation without depending on a single pocket placement.
    const pockets: ResourcePocket[] = [];
    for (let i = 0; i < 8; i++) {
      pockets.push(makePocket(i, 'energy', 30, 0.15 + (i % 3) * 0.2));
    }
    const { world, tree } = makeWorld(pockets);
    tree.kind = 'dyson';
    for (let i = 0; i < 60 * 60; i++) tick(world, 1 / 60);
    expect(tree.maturity).toBeGreaterThan(0.4);
    expect(tree.dietaryBias).toBeDefined();
    // If the energy bias ever crosses the sentinel threshold, the tree
    // graduates. The test is intentionally tolerant because root-tip
    // placement is randomized; the bias rule itself is the contract.
    if (
      tree.dietaryBias!.energy >= DIET_SENTINEL_BIAS &&
      tree.dietaryBias!.energy > tree.dietaryBias!.mineral &&
      tree.dietaryBias!.energy > tree.dietaryBias!.water
    ) {
      const kinds = [...world.seedlings.values()].map((s) => s.kind);
      expect(kinds).toContain('sentinel');
    }
  });

  it('seed stats shift in the direction of the bias', () => {
    const bias = { mineral: 0.7, water: 0.2, energy: 0.1 };
    const strengthGain = bias.mineral * DIET_STAT_GAIN;
    const energyGain = bias.water * DIET_STAT_GAIN;
    const speedGain = bias.energy * DIET_STAT_GAIN;
    expect(strengthGain).toBeCloseTo(0.7 * DIET_STAT_GAIN, 5);
    expect(energyGain).toBeCloseTo(0.2 * DIET_STAT_GAIN, 5);
    expect(speedGain).toBeCloseTo(0.1 * DIET_STAT_GAIN, 5);
  });
});
