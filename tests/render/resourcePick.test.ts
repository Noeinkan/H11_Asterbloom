import { describe, expect, it } from 'vitest';
import {
  CORE_HIT_T,
  POCKET_HIT_T,
  pickResourceAt,
  pocketHitCircles,
  type RockPickTarget,
} from '../../src/game/render/resourcePick';

const RADIUS = 100;

function rockAt(x: number, y: number): RockPickTarget {
  return {
    asteroidId: 7,
    x,
    y,
    radius: RADIUS,
    // One pocket due east, halfway out.
    pockets: pocketHitCircles({
      radius: RADIUS,
      pockets: [{ id: 3, angle: 0, radiusT: 0.5, kind: 'mineral' }],
    }),
  };
}

describe('pocketHitCircles', () => {
  it('places a pocket on its bearing at radiusT of the rock radius', () => {
    const [c] = pocketHitCircles({
      radius: RADIUS,
      pockets: [{ id: 1, angle: Math.PI / 2, radiusT: 0.4, kind: 'water' }],
    });
    expect(c!.x).toBeCloseTo(0, 6);
    expect(c!.y).toBeCloseTo(40, 6);
    expect(c!.r).toBeCloseTo(RADIUS * POCKET_HIT_T, 6);
    expect(c!.kind).toBe('water');
  });
});

describe('pickResourceAt', () => {
  it('hits a pocket on a rock away from the world origin', () => {
    // The regression this helper exists for: the view's pocket cache is
    // asteroid-local, so a rock anywhere but (0,0) used to miss entirely.
    const rock = rockAt(500, -300);
    const hit = pickResourceAt(rock, 500 + 50, -300);
    expect(hit).toEqual({ target: 'pocket', pocketId: 3, asteroidId: 7 });
  });

  it('resolves the same offsets identically at the origin and away from it', () => {
    const offsets: [number, number][] = [
      [50, 0],
      [0, 0],
      [0, 70],
      [400, 0],
    ];
    for (const [dx, dy] of offsets) {
      const here = pickResourceAt(rockAt(0, 0), dx, dy);
      const there = pickResourceAt(rockAt(-820, 640), -820 + dx, 640 + dy);
      expect(there, `offset ${dx},${dy}`).toEqual(here);
    }
  });

  it('returns the core at the centre', () => {
    expect(pickResourceAt(rockAt(0, 0), 0, 0)).toEqual({
      target: 'core',
      asteroidId: 7,
    });
  });

  it('lets a pocket win over the core when the two discs overlap', () => {
    const rock: RockPickTarget = {
      asteroidId: 7,
      x: 0,
      y: 0,
      radius: RADIUS,
      // Deliberately parked on the core well.
      pockets: pocketHitCircles({
        radius: RADIUS,
        pockets: [{ id: 9, angle: 0, radiusT: 0.02, kind: 'energy' }],
      }),
    };
    expect(pickResourceAt(rock, 0, 0)).toEqual({
      target: 'pocket',
      pocketId: 9,
      asteroidId: 7,
    });
  });

  it('reports bare crust between the core and the rim', () => {
    const between = RADIUS * (CORE_HIT_T + 1) * 0.5;
    expect(pickResourceAt(rockAt(0, 0), 0, between)).toEqual({
      target: 'body',
      asteroidId: 7,
    });
  });

  it('returns null past the rim', () => {
    expect(pickResourceAt(rockAt(0, 0), 0, RADIUS + 0.5)).toBeNull();
    expect(pickResourceAt(rockAt(0, 0), RADIUS * 2, 0)).toBeNull();
  });

  it('includes the rim itself but not a hair beyond', () => {
    expect(pickResourceAt(rockAt(0, 0), RADIUS, 0)?.target).toBe('body');
    expect(pickResourceAt(rockAt(0, 0), RADIUS + 1e-6, 0)).toBeNull();
  });

  it('gives a pocket a hit disc wider than the drawn orb', () => {
    const rock = rockAt(0, 0);
    const edge = RADIUS * 0.5 + RADIUS * POCKET_HIT_T * 0.99;
    expect(pickResourceAt(rock, edge, 0)?.target).toBe('pocket');
    const outside = RADIUS * 0.5 + RADIUS * POCKET_HIT_T * 1.01;
    expect(pickResourceAt(rock, outside, 0)?.target).toBe('body');
  });
});
