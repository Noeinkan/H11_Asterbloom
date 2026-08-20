/** Persistent player prefs — localStorage with safe fallbacks. */

export const MUTE_STORAGE_KEY = 'asterbloom.mute.v1';
export const REDUCED_MOTION_STORAGE_KEY = 'asterbloom.reducedMotion.v1';
export const HUD_SCALE_STORAGE_KEY = 'asterbloom.hudScale.v1';
export const FACTION_MARKS_STORAGE_KEY = 'asterbloom.factionMarks.v1';
export const SCREEN_FLASH_STORAGE_KEY = 'asterbloom.screenFlash.v1';
export const MINIMAP_STORAGE_KEY = 'asterbloom.minimap.v1';

/** Ship version — keep in sync with package.json. */
export const GAME_VERSION = '0.1.0';

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * `storageGet(k) === '1'` can only ever default to false, and some prefs
 * (screen flash) ship on. An unset key falls back; anything else is explicit.
 */
function readBool(key: string, fallback: boolean): boolean {
  const raw = storageGet(key);
  if (raw === null) return fallback;
  return raw === '1';
}

export function readMuted(): boolean {
  return storageGet(MUTE_STORAGE_KEY) === '1';
}

export function writeMuted(muted: boolean): void {
  storageSet(MUTE_STORAGE_KEY, muted ? '1' : '0');
}

export function readReducedMotion(): boolean {
  return storageGet(REDUCED_MOTION_STORAGE_KEY) === '1';
}

export function writeReducedMotion(enabled: boolean): void {
  storageSet(REDUCED_MOTION_STORAGE_KEY, enabled ? '1' : '0');
}

export function applyReducedMotionClass(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('ab-reduced-motion', enabled);
}

/**
 * HUD text ladder. Never below 1: the coarse-pointer rules already hold every
 * control at a 44px minimum, so scaling only ever grows the HUD.
 */
export const HUD_SCALE_STEPS: readonly number[] = [1, 1.15, 1.3, 1.5];

/** Snap an arbitrary number onto the ladder (nearest step). */
export function clampHudScale(v: number): number {
  if (!Number.isFinite(v)) return HUD_SCALE_STEPS[0]!;
  let best = HUD_SCALE_STEPS[0]!;
  for (const step of HUD_SCALE_STEPS) {
    if (Math.abs(step - v) < Math.abs(best - v)) best = step;
  }
  return best;
}

/** Next step up, wrapping back to the smallest — the Settings button cycles. */
export function nextHudScale(v: number): number {
  const i = HUD_SCALE_STEPS.indexOf(clampHudScale(v));
  return HUD_SCALE_STEPS[(i + 1) % HUD_SCALE_STEPS.length]!;
}

export function readHudScale(): number {
  const raw = storageGet(HUD_SCALE_STORAGE_KEY);
  if (raw === null) return HUD_SCALE_STEPS[0]!;
  return clampHudScale(Number.parseFloat(raw));
}

export function writeHudScale(scale: number): void {
  storageSet(HUD_SCALE_STORAGE_KEY, String(clampHudScale(scale)));
}

export function applyHudScale(scale: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(
    '--ab-hud-scale',
    String(clampHudScale(scale)),
  );
}

/** Non-color faction glyphs on hulls, rocks, and the minimap. Default off. */
export function readFactionMarks(): boolean {
  return readBool(FACTION_MARKS_STORAGE_KEY, false);
}

export function writeFactionMarks(enabled: boolean): void {
  storageSet(FACTION_MARKS_STORAGE_KEY, enabled ? '1' : '0');
}

/** Hit flashes and pocket-feed pulses. Default on — it reads as game feel. */
export function readScreenFlash(): boolean {
  return readBool(SCREEN_FLASH_STORAGE_KEY, true);
}

export function writeScreenFlash(enabled: boolean): void {
  storageSet(SCREEN_FLASH_STORAGE_KEY, enabled ? '1' : '0');
}

export function readMinimap(): boolean {
  return readBool(MINIMAP_STORAGE_KEY, true);
}

export function writeMinimap(enabled: boolean): void {
  storageSet(MINIMAP_STORAGE_KEY, enabled ? '1' : '0');
}
