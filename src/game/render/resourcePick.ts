/**
 * Hit testing for a rock's subsurface targets.
 *
 * Pure geometry, no Pixi: `AsteroidView` owns the cache and the highlight
 * layer, this owns the arithmetic. Split out because the coordinate frame is
 * the easy thing to get wrong — the view's container is translated to the
 * rock, so its cached pocket positions are asteroid-local while every caller
 * has a world point.
 */

import type { ResourceKind } from '../sim/types';

/** Pocket hit radius as a fraction of rock radius — a touch over the orb. */
export const POCKET_HIT_T = 0.13;

/** Core-well hit radius as a fraction of rock radius. */
export const CORE_HIT_T = 0.2;

/** One pocket's hit disc, in asteroid-local coordinates. */
export interface PocketHitCircle {
  id: number;
  x: number;
  y: number;
  r: number;
  kind: ResourceKind;
}

/**
 * What the cursor found on a rock. `body` means bare crust: no subsurface
 * target under the pointer, but still this asteroid — enough for the hover
 * panel to open on the planet as a whole.
 */
export type ResourceHit =
  | { target: 'pocket'; pocketId: number; asteroidId: number }
  | { target: 'core'; asteroidId: number }
  | { target: 'body'; asteroidId: number };

export interface RockPickTarget {
  asteroidId: number;
  /** Rock centre, world space. */
  x: number;
  y: number;
  /** Mean rock radius. */
  radius: number;
  pockets: readonly PocketHitCircle[];
}

/**
 * Resolve a world point against one rock.
 *
 * Precision beats area: pockets win over the core, and the core wins over
 * bare crust, so the small targets stay reachable inside the large one.
 * Returns `null` when the point is off the disc entirely.
 */
export function pickResourceAt(
  rock: RockPickTarget,
  worldX: number,
  worldY: number,
): ResourceHit | null {
  const lx = worldX - rock.x;
  const ly = worldY - rock.y;
  for (const p of rock.pockets) {
    const dx = p.x - lx;
    const dy = p.y - ly;
    if (dx * dx + dy * dy <= p.r * p.r) {
      return { target: 'pocket', pocketId: p.id, asteroidId: rock.asteroidId };
    }
  }
  const dist2 = lx * lx + ly * ly;
  const coreR = rock.radius * CORE_HIT_T;
  if (dist2 <= coreR * coreR) {
    return { target: 'core', asteroidId: rock.asteroidId };
  }
  if (dist2 <= rock.radius * rock.radius) {
    return { target: 'body', asteroidId: rock.asteroidId };
  }
  return null;
}

/** Asteroid-local hit discs for a rock's pockets. */
export function pocketHitCircles(asteroid: {
  radius: number;
  pockets: readonly {
    id: number;
    angle: number;
    radiusT: number;
    kind: ResourceKind;
  }[];
}): PocketHitCircle[] {
  const out: PocketHitCircle[] = [];
  for (const pocket of asteroid.pockets) {
    const r = pocket.radiusT * asteroid.radius;
    out.push({
      id: pocket.id,
      x: Math.cos(pocket.angle) * r,
      y: Math.sin(pocket.angle) * r,
      r: asteroid.radius * POCKET_HIT_T,
      kind: pocket.kind,
    });
  }
  return out;
}
