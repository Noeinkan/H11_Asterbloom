import { describe, expect, it } from 'vitest';
import { generatePockets, POCKET_SLOT_CLEARANCE } from '../../src/game/sim/pockets';
import { mulberry32 } from '../../src/game/sim/rng';
import {
  POCKET_REGEN_PER_SEC,
  POCKETS_PER_ROCK,
  type ResourcePocket,
  type ResourceRole,
} from '../../src/game/sim/types';
import {
  addAsteroid,
  computeRootIntake,
  createEmptyWorld,
  tick,
} from '../../src/game/sim/world';

describe('generatePockets', () => {
  it('produces the right count per role', () => {
    const roles: ResourceRole[] = ['home', 'enemy', 'energy', 'wild', 'empty'];
    for (const role of roles) {
      const pockets = generatePockets(mulberry32(1), role, []);
      expect(pockets.length).toBe(POCKETS_PER_ROCK[role]);
    }
  });

  it('keeps pockets clear of tree slot angles', () => {
    const treeSlotAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    const pockets = generatePockets(mulberry32(42), 'home', treeSlotAngles);
    for (const p of pockets) {
      for (const slot of treeSlotAngles) {
        let d = Math.abs(p.angle - slot);
        while (d > Math.PI) d -= Math.PI * 2;
        expect(Math.abs(d)).toBeGreaterThanOrEqual(POCKET_SLOT_CLEARANCE - 1e-9);
      }
    }
  });

  it('places pockets within the subsurface band', () => {
    const pockets = generatePockets(mulberry32(7), 'energy', []);
    for (const p of pockets) {
      expect(p.radiusT).toBeGreaterThanOrEqual(0.35);
      expect(p.radiusT).toBeLessThanOrEqual(0.78);
      expect(p.depthT).toBeGreaterThanOrEqual(0.05);
      expect(p.depthT).toBeLessThanOrEqual(0.18);
      expect(p.amount).toBe(p.maxAmount);
    }
  });
});

describe('pocket regen and depletion', () => {
  it('regens a drained pocket toward its max when not extracted', () => {
    const world = createEmptyWorld(7);
    const pocket: ResourcePocket = {
      id: 0,
      kind: 'mineral',
      amount: 0,
      maxAmount: 10,
      angle: 0,
      radiusT: 0.5,
      depthT: 0.1,
      regenPerSec: POCKET_REGEN_PER_SEC,
      depletedAt: 0,
      phase: 0,
    };
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      pockets: [pocket],
    });
    const before = rock.pockets[0]!.amount;
    for (let i = 0; i < 60; i++) tick(world, 1 / 60);
    expect(rock.pockets[0]!.amount).toBeGreaterThan(before);
    expect(rock.pockets[0]!.amount).toBeLessThanOrEqual(10);
    expect(rock.pockets[0]!.depletedAt).toBeNull();
  });

  it('depleted pockets stop yielding but keep existing', () => {
    const world = createEmptyWorld(8);
    const depleted: ResourcePocket = {
      id: 0,
      kind: 'mineral',
      amount: 0,
      maxAmount: 14,
      angle: 0.5,
      radiusT: 0.4,
      depthT: 0.1,
      regenPerSec: POCKET_REGEN_PER_SEC,
      depletedAt: 1,
      phase: 0,
    };
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      pockets: [depleted],
    });
    const intake = computeRootIntake(rock, 12345, 0, 'dyson');
    expect(intake.mineral).toBe(0);
    expect(intake.water).toBe(0);
    expect(intake.energy).toBe(0);
    expect(rock.pockets.length).toBe(1);
  });
});
