import { range, type Rng } from './rng';
import {
  POCKET_AMOUNT_ENERGY,
  POCKET_AMOUNT_MINERAL,
  POCKET_AMOUNT_WATER,
  POCKET_REGEN_PER_SEC,
  POCKETS_PER_ROCK,
  type ResourceKind,
  type ResourcePocket,
  type ResourceRole,
} from './types';

const KIND_ORDER: readonly ResourceKind[] = ['mineral', 'water', 'energy'];

/** Angular margin kept clear of any tree slot (radians). */
export const POCKET_SLOT_CLEARANCE = 0.18;

/** Signed shortest angular distance (radians), absolute value. */
function angleDist(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/**
 * Roll the subsurface resource pockets for a rock. Pockets sit in the
 * playable band [0.35, 0.78] of the radius and never crowd a tree slot.
 * Kinds cycle through mineral/water/energy from a random offset so rocks
 * with three or more pockets always show all three colors.
 */
export function generatePockets(
  rng: Rng,
  role: ResourceRole,
  treeSlotAngles: readonly number[],
): ResourcePocket[] {
  const count = POCKETS_PER_ROCK[role];
  const amountTables: Record<ResourceKind, Record<ResourceRole, number>> = {
    mineral: POCKET_AMOUNT_MINERAL,
    water: POCKET_AMOUNT_WATER,
    energy: POCKET_AMOUNT_ENERGY,
  };

  const pockets: ResourcePocket[] = [];
  const start = Math.floor(rng() * KIND_ORDER.length);

  for (let i = 0; i < count; i++) {
    const kind = KIND_ORDER[(start + i) % KIND_ORDER.length]!;
    const amount = amountTables[kind][role];

    // Uniform bearing, retried until clear of every tree slot.
    let angle = rng() * Math.PI * 2;
    for (let attempt = 0; attempt < 48; attempt++) {
      let clear = true;
      for (const slotAngle of treeSlotAngles) {
        if (angleDist(angle, slotAngle) < POCKET_SLOT_CLEARANCE) {
          clear = false;
          break;
        }
      }
      if (clear) break;
      angle = rng() * Math.PI * 2;
    }

    pockets.push({
      id: i,
      kind,
      amount,
      maxAmount: amount,
      angle,
      radiusT: range(rng, 0.35, 0.78),
      depthT: range(rng, 0.05, 0.18),
      regenPerSec: POCKET_REGEN_PER_SEC,
      depletedAt: null,
      phase: rng() * Math.PI * 2,
    });
  }

  return pockets;
}
