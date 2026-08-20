import { shortestPath } from './graph';
import { shortestAngle } from './life';
import { slotPolar } from './rock';
import {
  canPlantKind,
  PLANT_COST,
  PLANT_STAGGER,
  SEND_STAGGER,
  type Asteroid,
  type FactionId,
  type PendingPlant,
  type SeedlingKind,
  type TreeKind,
  type World,
} from './types';
import {
  allocId,
  countSendReady,
  getOccupiedSlots,
  hasHostileOrbiters,
  hasHostileTrees,
  nextEmptySlot,
  plantPose,
  spawnOrbiters,
} from './world';

export type CommandResult =
  | { ok: true; count?: number }
  | { ok: false; reason: string };

function crustAngleTaken(
  world: World,
  asteroid: Asteroid,
  angle: number,
): boolean {
  const minSep = ((Math.PI * 2) / Math.max(2, asteroid.treeSlots)) * 0.5;
  const taken: number[] = [];
  for (const t of world.trees.values()) {
    if (t.asteroidId !== asteroid.id) continue;
    taken.push(t.plantAngle ?? slotPolar(asteroid, t.slotIndex).angle);
  }
  for (const p of world.pendingPlants.values()) {
    if (p.asteroidId !== asteroid.id) continue;
    taken.push(p.plantAngle ?? slotPolar(asteroid, p.slotIndex).angle);
  }
  for (const other of taken) {
    if (Math.abs(shortestAngle(angle, other)) < minSep) return true;
  }
  return false;
}

function destLooksHostile(
  world: World,
  toId: number,
  faction: FactionId,
): boolean {
  const dest = world.asteroids.get(toId);
  if (!dest) return false;
  if (hasHostileOrbiters(world, toId, faction)) return true;
  if (dest.owner !== faction && dest.owner !== 'neutral') return true;
  return false;
}

export function sendSeedlings(
  world: World,
  fromId: number,
  toId: number,
  count: number,
  faction: FactionId,
): CommandResult {
  if (fromId === toId) return { ok: false, reason: 'same asteroid' };
  if (count < 1) return { ok: false, reason: 'count < 1' };

  const path = shortestPath(world, fromId, toId);
  if (!path || path.length < 2) return { ok: false, reason: 'no path' };

  const available: number[] = [];
  for (const s of world.seedlings.values()) {
    if (
      s.state === 'orbit' &&
      s.asteroidId === fromId &&
      s.faction === faction
    ) {
      available.push(s.id);
    }
  }
  if (available.length === 0) return { ok: false, reason: 'no seedlings' };

  const raid = destLooksHostile(world, toId, faction);
  available.sort((a, b) => {
    const sa = world.seedlings.get(a)!;
    const sb = world.seedlings.get(b)!;
    const aSent = sa.kind === 'sentinel' ? 1 : 0;
    const bSent = sb.kind === 'sentinel' ? 1 : 0;
    return raid ? bSent - aSent : aSent - bSent;
  });

  const n = Math.min(count, available.length);
  for (let i = 0; i < n; i++) {
    const s = world.seedlings.get(available[i]!)!;
    s.state = 'travel';
    s.path = path;
    s.pathIndex = 1;
    s.wait = i * SEND_STAGGER;
  }
  return { ok: true, count: n };
}

export function plantTree(
  world: World,
  asteroidId: number,
  slotIndex: number,
  faction: FactionId,
  kind: TreeKind = 'dyson',
  plantAngle?: number,
): CommandResult {
  const asteroid = world.asteroids.get(asteroidId);
  if (!asteroid) return { ok: false, reason: 'no asteroid' };
  if (slotIndex < 0 || slotIndex >= asteroid.treeSlots) {
    return { ok: false, reason: 'bad slot' };
  }
  if (!canPlantKind(asteroid.stats.energy, kind)) {
    return {
      ok: false,
      reason: kind === 'energy' ? 'need energy-rich rock' : 'need energy for shields',
    };
  }
  if (hasHostileOrbiters(world, asteroidId, faction)) {
    return { ok: false, reason: 'contested' };
  }
  if (hasHostileTrees(world, asteroidId, faction)) {
    return { ok: false, reason: 'enemy trees' };
  }

  const occupied = getOccupiedSlots(world, asteroidId);
  if (occupied.has(slotIndex)) return { ok: false, reason: 'slot taken' };
  if (
    plantAngle !== undefined &&
    crustAngleTaken(world, asteroid, plantAngle)
  ) {
    return { ok: false, reason: 'too close' };
  }

  const candidates: number[] = [];
  for (const s of world.seedlings.values()) {
    if (
      s.state === 'orbit' &&
      s.asteroidId === asteroidId &&
      s.faction === faction
    ) {
      candidates.push(s.id);
    }
  }
  if (candidates.length < PLANT_COST) {
    return { ok: false, reason: 'need 10 seedlings' };
  }

  const pos = plantPose(asteroid, slotIndex, plantAngle);
  const chosen = candidates.slice(0, PLANT_COST);
  const plantId = allocId(world);
  const pending: PendingPlant = {
    id: plantId,
    asteroidId,
    slotIndex,
    plantAngle,
    faction,
    kind,
    seedlingIds: chosen,
    arrived: 0,
  };
  world.pendingPlants.set(plantId, pending);

  for (let i = 0; i < chosen.length; i++) {
    const s = world.seedlings.get(chosen[i]!)!;
    s.state = 'plant';
    s.plantId = plantId;
    s.plantTargetX = pos.x;
    s.plantTargetY = pos.y;
    s.wait = i * PLANT_STAGGER;
  }

  return { ok: true, count: PLANT_COST };
}

export function plantDyson(
  world: World,
  asteroidId: number,
  slotIndex: number,
  faction: FactionId,
): CommandResult {
  return plantTree(world, asteroidId, slotIndex, faction, 'dyson');
}

/**
 * Plant from a crust bearing rather than a slot index: the command picks the
 * slot itself. Callers that only know where the player clicked — the crust
 * menu, and the offline replay that re-applies it — must not reproduce slot
 * resolution, because which slot is free depends on live world state.
 */
export function plantOnCrustAngle(
  world: World,
  asteroidId: number,
  angle: number,
  faction: FactionId,
  kind: TreeKind = 'dyson',
): CommandResult {
  const slot = nextEmptySlot(world, asteroidId);
  if (slot === null) return { ok: false, reason: 'slot taken' };
  return plantTree(world, asteroidId, slot, faction, kind, angle);
}

export function countFactionOrbiting(
  world: World,
  asteroidId: number,
  faction: FactionId,
): number {
  return countSendReady(world, asteroidId, faction);
}

/** Helper for tests: force-spawn orbiting seedlings on an asteroid. */
export function debugSpawnOrbiters(
  world: World,
  asteroidId: number,
  faction: FactionId,
  n: number,
  kind: SeedlingKind = 'basic',
): void {
  spawnOrbiters(world, asteroidId, faction, n, kind);
}
