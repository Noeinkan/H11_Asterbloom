import { describe, expect, it } from 'vitest';
import { isTapped, surveyPlanet } from '../../src/game/hud/planetPanel';
import { POCKET_REGEN_PER_SEC, type ResourcePocket } from '../../src/game/sim/types';
import { addAsteroid, createEmptyWorld } from '../../src/game/sim/world';

function pocket(
  id: number,
  kind: ResourcePocket['kind'],
  amount: number,
  depletedAt: number | null = null,
): ResourcePocket {
  return {
    id,
    kind,
    amount,
    maxAmount: 14,
    angle: id,
    radiusT: 0.5,
    depthT: 0.1,
    regenPerSec: POCKET_REGEN_PER_SEC,
    depletedAt,
    phase: 0,
  };
}

function rock(pockets: ResourcePocket[]) {
  const world = createEmptyWorld(9);
  return addAsteroid(world, {
    x: 120,
    y: -40,
    travelRadius: 300,
    owner: 'player',
    coreEnergy: 30,
    maxCoreEnergy: 100,
    pockets,
  });
}

describe('surveyPlanet', () => {
  it("lists every pocket in the rock's own order", () => {
    const survey = surveyPlanet(
      rock([pocket(0, 'mineral', 14), pocket(1, 'water', 6), pocket(2, 'energy', 2)]),
      new Map(),
      0,
      null,
    );
    expect(survey.pockets.map((p) => p.kind)).toEqual([
      'mineral',
      'water',
      'energy',
    ]);
    expect(survey.pockets.map((p) => p.id)).toEqual([0, 1, 2]);
  });

  it('carries the core reservoir and rock headline through', () => {
    const asteroid = rock([]);
    const survey = surveyPlanet(asteroid, new Map(), 2, null);
    expect(survey.asteroidId).toBe(asteroid.id);
    expect(survey.name).toBe(asteroid.name);
    expect(survey.owner).toBe('player');
    expect(survey.coreEnergy).toBe(30);
    expect(survey.maxCoreEnergy).toBe(100);
    expect(survey.treesPlanted).toBe(2);
    expect(survey.treeSlots).toBe(asteroid.treeSlots);
    expect(survey.pockets).toEqual([]);
  });

  it('attaches the live drain rate per pocket, defaulting to zero', () => {
    const survey = surveyPlanet(
      rock([pocket(0, 'mineral', 14), pocket(1, 'water', 14)]),
      new Map([[1, 0.42]]),
      1,
      null,
    );
    expect(survey.pockets[0]!.drain).toBe(0);
    expect(survey.pockets[1]!.drain).toBeCloseTo(0.42, 6);
    expect(isTapped(survey.pockets[0]!)).toBe(false);
    expect(isTapped(survey.pockets[1]!)).toBe(true);
  });

  it('treats a rounding-noise drain as not tapped', () => {
    const survey = surveyPlanet(
      rock([pocket(0, 'mineral', 14)]),
      new Map([[0, 1e-6]]),
      1,
      null,
    );
    expect(survey.pockets[0]!.drain).toBeGreaterThan(0);
    expect(isTapped(survey.pockets[0]!)).toBe(false);
  });

  it('flags depletion from the simulation stamp, not the amount', () => {
    const survey = surveyPlanet(
      // A pocket regenerating from empty still holds a little, but the sim
      // has not cleared its stamp yet — the panel must follow the sim.
      rock([pocket(0, 'mineral', 0, 12.5), pocket(1, 'water', 0, null)]),
      new Map(),
      0,
      null,
    );
    expect(survey.pockets[0]!.depleted).toBe(true);
    expect(survey.pockets[1]!.depleted).toBe(false);
  });

  it('passes the hover focus through unchanged', () => {
    const pockets = [pocket(0, 'mineral', 14)];
    expect(surveyPlanet(rock(pockets), new Map(), 0, null).focus).toBeNull();
    expect(
      surveyPlanet(rock(pockets), new Map(), 0, { target: 'core' }).focus,
    ).toEqual({ target: 'core' });
    expect(
      surveyPlanet(rock(pockets), new Map(), 0, {
        target: 'pocket',
        pocketId: 0,
      }).focus,
    ).toEqual({ target: 'pocket', pocketId: 0 });
  });

  it("does not alias the rock's own pocket objects", () => {
    const asteroid = rock([pocket(0, 'mineral', 14)]);
    const survey = surveyPlanet(asteroid, new Map(), 0, null);
    survey.pockets[0]!.amount = 0;
    expect(asteroid.pockets[0]!.amount).toBe(14);
  });
});
