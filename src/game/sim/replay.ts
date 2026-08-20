/**
 * Match replay — a seed plus the player's commands.
 *
 * Two properties make this small. `tickAi` is entirely RNG-free (it reads
 * `world.aiAcc`, the difficulty knobs, and integer scores over Map iteration
 * order), and every RNG in the sim is a throwaway `mulberry32` seeded from
 * world and entity state rather than a stream carried on the world. So the
 * rival replays itself, and only the player's intent has to be recorded.
 *
 * What is recorded is the *input*, not the resolved outcome: a plant stores
 * the rock and the crust bearing the player clicked, never the slot index,
 * because which slot is free depends on the state of the world at the moment
 * the command lands. `plantOnCrustAngle` resolves it identically on both
 * passes.
 *
 * Determinism caveats worth knowing before trusting a log:
 * - `spawnSeedling` mixes `world.nextId` into its seed and `spawnOrbiters`
 *   mixes in the batch size, so commands cannot be reordered or skipped; the
 *   log is a sequence, not a set.
 * - `sendSeedlings` sorts candidates by the sentinel flag alone, and
 *   `Array.prototype.sort` is stable per spec, so ties resolve by Map
 *   insertion order.
 *
 * `replay()` drives `tick`/`tickAi` directly. That is the one place outside
 * the app ticker that does so, deliberately: it is an offline re-simulation
 * with no renderer, no HUD and no audio, and nothing in `main.ts` calls it.
 */

import { startCampaignMap, startSkirmishWorld } from './campaign';
import { plantOnCrustAngle, sendSeedlings } from './commands';
import {
  createMatchRuntime,
  tickMatchRuntime,
  type MatchConfig,
  type MatchRuntime,
} from './match';
import { tickAi } from './ai';
import { SIM_DT, type Difficulty, type TreeKind, type World } from './types';
import { tick } from './world';

export const REPLAY_SCHEMA_VERSION = 1;

export type ReplayStart =
  | { mode: 'skirmish'; seed: number; difficulty: Difficulty }
  | { mode: 'campaign'; index: number };

export type ReplayCommand =
  | { t: number; k: 'send'; from: number; to: number; n: number }
  | { t: number; k: 'plant'; rock: number; angle: number; tree: TreeKind };

export interface ReplayLog {
  schema: number;
  start: ReplayStart;
  commands: ReplayCommand[];
}

export function createReplayLog(start: ReplayStart): ReplayLog {
  return { schema: REPLAY_SCHEMA_VERSION, start, commands: [] };
}

/**
 * `tick` here is the number of *completed* sim steps when the command was
 * issued. A pointerup lands between frames and mutates the world before the
 * next step runs, so the replay applies commands at `t` before running step
 * `t` — see `replay` below.
 */
export function recordSend(
  log: ReplayLog,
  tickIndex: number,
  from: number,
  to: number,
  n: number,
): void {
  log.commands.push({ t: tickIndex, k: 'send', from, to, n });
}

export function recordPlant(
  log: ReplayLog,
  tickIndex: number,
  rock: number,
  angle: number,
  kind: TreeKind,
): void {
  log.commands.push({ t: tickIndex, k: 'plant', rock, angle, tree: kind });
}

/** Rebuild the starting world a log was recorded against. */
export function startWorldFor(start: ReplayStart): {
  world: World;
  config: MatchConfig;
} {
  if (start.mode === 'campaign') {
    const started = startCampaignMap(start.index);
    return { world: started.world, config: started.config };
  }
  return startSkirmishWorld(start.seed, start.difficulty);
}

export interface ReplayResult {
  world: World;
  config: MatchConfig;
  runtime: MatchRuntime;
  ticks: number;
}

/**
 * Re-simulate `ticks` fixed steps, applying the log along the way. Command
 * results are ignored on purpose: a command that fails on the replay pass
 * would also have failed live, and it mutates nothing either way.
 */
export function replay(log: ReplayLog, ticks: number): ReplayResult {
  const { world, config } = startWorldFor(log.start);
  const runtime = createMatchRuntime();

  // Commands are grouped by tick so the inner loop never rescans the log.
  const byTick = new Map<number, ReplayCommand[]>();
  for (const c of log.commands) {
    const bucket = byTick.get(c.t);
    if (bucket) bucket.push(c);
    else byTick.set(c.t, [c]);
  }

  for (let t = 0; t < ticks; t++) {
    const due = byTick.get(t);
    if (due) {
      for (const c of due) applyCommand(world, c);
    }
    tick(world, SIM_DT);
    tickAi(world, SIM_DT);
    tickMatchRuntime(world, config, runtime, SIM_DT);
  }

  return { world, config, runtime, ticks };
}

function applyCommand(world: World, c: ReplayCommand): void {
  if (c.k === 'send') {
    sendSeedlings(world, c.from, c.to, c.n, 'player');
    return;
  }
  plantOnCrustAngle(world, c.rock, c.angle, 'player', c.tree);
}

export function encodeReplay(log: ReplayLog): string {
  return JSON.stringify(log);
}

/** Returns null for anything that is not a log this build can replay. */
export function decodeReplay(raw: string): ReplayLog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const log = parsed as Partial<ReplayLog>;
  if (log.schema !== REPLAY_SCHEMA_VERSION) return null;
  if (!Array.isArray(log.commands)) return null;

  const start = log.start;
  if (!start || typeof start !== 'object') return null;
  if (start.mode === 'skirmish') {
    if (!Number.isFinite(start.seed)) return null;
  } else if (start.mode === 'campaign') {
    if (!Number.isFinite(start.index)) return null;
  } else {
    return null;
  }

  for (const c of log.commands) {
    if (!c || typeof c !== 'object') return null;
    if (!Number.isFinite(c.t)) return null;
    if (c.k !== 'send' && c.k !== 'plant') return null;
  }

  return { schema: log.schema, start, commands: log.commands };
}
