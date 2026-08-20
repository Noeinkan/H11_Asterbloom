/**
 * Mid-match save slot.
 *
 * `sim/serialize.ts` turns the `World` into JSON-safe data; this adds the
 * session state that lives outside the world — which mode is running, the win
 * rule and its progress, the camera, and the send/plant selection — and puts
 * the envelope in `localStorage`.
 *
 * It sits in `hud/` for the same reason `prefs.ts` does: `sim/` stays free of
 * browser APIs, and everything here is storage plumbing. The encode/decode
 * pair is pure so the format is testable without a DOM.
 */

import type { SendMode } from '../input/sendCount';
import type { MatchConfig } from '../sim/match';
import type { WorldSnapshot } from '../sim/serialize';
import type { Difficulty, TreeKind } from '../sim/types';
import { GAME_VERSION } from './prefs';

export const SAVE_STORAGE_KEY = 'asterbloom.save.v1';
export const SAVE_SCHEMA_VERSION = 1;

export interface SessionSnapshot {
  schema: number;
  /** Ship version. A save from another build is discarded, not migrated. */
  version: string;
  savedAt: number;
  mode: 'skirmish' | 'campaign';
  seed: number;
  difficulty: Difficulty;
  campaignIndex: number;
  campaignTitle: string;
  matchConfig: MatchConfig;
  /** `MatchRuntime.holdAcc` — progress toward a "hold N rocks" win. */
  holdAcc: number;
  world: WorldSnapshot;
  camera: { x: number; y: number; zoom: number };
  view: {
    selectedAsteroidId: number | null;
    sendCount: number;
    sendMode: SendMode;
    plantKind: TreeKind;
  };
  followSend: boolean;
  /**
   * Palette / starfield phase. Restoring it is what stops the sky from
   * snapping to a different colour the moment a match resumes.
   */
  palTime: number;
}

export function encodeSession(snapshot: SessionSnapshot): string {
  return JSON.stringify(snapshot);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parse and validate. Returns null rather than throwing, because every caller
 * has the same answer for a bad save: ignore it and offer a fresh match.
 */
export function decodeSession(raw: string): SessionSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Partial<SessionSnapshot>;

  if (s.schema !== SAVE_SCHEMA_VERSION) return null;
  // A save is a snapshot of one build's simulation. Balance constants and
  // world fields move between versions, so an old payload is discarded
  // rather than guessed at.
  if (s.version !== GAME_VERSION) return null;
  if (s.mode !== 'skirmish' && s.mode !== 'campaign') return null;
  if (!isFiniteNumber(s.seed)) return null;
  if (!s.world || typeof s.world !== 'object') return null;
  if (!s.matchConfig || typeof s.matchConfig !== 'object') return null;
  if (!s.camera || !isFiniteNumber(s.camera.zoom)) return null;
  if (!s.view || typeof s.view !== 'object') return null;

  return {
    schema: s.schema,
    version: s.version,
    savedAt: isFiniteNumber(s.savedAt) ? s.savedAt : 0,
    mode: s.mode,
    seed: s.seed,
    difficulty: s.difficulty ?? 'normal',
    campaignIndex: isFiniteNumber(s.campaignIndex) ? s.campaignIndex : 0,
    campaignTitle: typeof s.campaignTitle === 'string' ? s.campaignTitle : '',
    matchConfig: s.matchConfig,
    holdAcc: isFiniteNumber(s.holdAcc) ? s.holdAcc : 0,
    world: s.world,
    camera: {
      x: isFiniteNumber(s.camera.x) ? s.camera.x : 0,
      y: isFiniteNumber(s.camera.y) ? s.camera.y : 0,
      zoom: s.camera.zoom,
    },
    view: {
      selectedAsteroidId: isFiniteNumber(s.view.selectedAsteroidId)
        ? s.view.selectedAsteroidId
        : null,
      sendCount: isFiniteNumber(s.view.sendCount) ? s.view.sendCount : 0,
      sendMode: s.view.sendMode ?? 'all',
      plantKind: s.view.plantKind ?? 'dyson',
    },
    followSend: s.followSend === true,
    palTime: isFiniteNumber(s.palTime) ? s.palTime : 0,
  };
}

export function readSave(): SessionSnapshot | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SAVE_STORAGE_KEY);
    if (raw === null) return null;
    return decodeSession(raw);
  } catch {
    return null;
  }
}

/**
 * Returns false when the write did not happen — a full or unavailable store.
 * Autosave ignores that: losing a save is not worth interrupting a match for.
 */
export function writeSave(snapshot: SessionSnapshot): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(SAVE_STORAGE_KEY, encodeSession(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(SAVE_STORAGE_KEY);
  } catch {
    /* ignore private mode */
  }
}

/** Cheap enough to call while rendering the title screen. */
export function hasSave(): boolean {
  return readSave() !== null;
}
