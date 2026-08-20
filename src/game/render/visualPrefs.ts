/**
 * Accessibility prefs as the renderer sees them.
 *
 * `hud/prefs.ts` owns storage and touches `document` / `localStorage`; nothing
 * under `render/` imports it. `main.ts` reads the prefs once at boot and again
 * whenever Settings changes, and pushes them here. Views read the current value
 * at paint time, so a mid-match toggle lands on the next frame without
 * rebuilding a single view.
 *
 * Every decision is a small pure function so the behaviour is testable without
 * a DOM — the module-level value is only the channel.
 */

export interface VisualPrefs {
  /** Brief brightness spikes: seedling hit flash, pocket feed, hit pulse. */
  screenFlash: boolean;
  /** Ambient drift with no gameplay meaning: shimmer, motes, hue cycle. */
  reducedMotion: boolean;
  /** Non-color faction glyphs on hulls, rocks, and the minimap. */
  factionMarks: boolean;
}

export const DEFAULT_VISUAL_PREFS: VisualPrefs = {
  screenFlash: true,
  reducedMotion: false,
  factionMarks: false,
};

let current: VisualPrefs = { ...DEFAULT_VISUAL_PREFS };

export function getVisualPrefs(): Readonly<VisualPrefs> {
  return current;
}

export function setVisualPrefs(next: Partial<VisualPrefs>): void {
  current = { ...current, ...next };
}

/** Test seam — restores the shipped defaults. */
export function resetVisualPrefs(): void {
  current = { ...DEFAULT_VISUAL_PREFS };
}

/** Seedling hit-flash duration. Zero leaves `now < flashUntil` always false. */
export const HIT_FLASH_MS = 120;

export function hitFlashMs(p: VisualPrefs): number {
  return p.screenFlash ? HIT_FLASH_MS : 0;
}

/** How long a rock's crust glows after roots pull from a pocket. */
export const POCKET_FLASH_SECONDS = 0.6;

export function pocketFlashSeconds(p: VisualPrefs): number {
  return p.screenFlash ? POCKET_FLASH_SECONDS : 0;
}

/**
 * Multiplier for decorative sine amplitudes. At 0 the wobble term vanishes and
 * the shape sits at its rest value — no branching at the call site.
 */
export function ambientMotion(p: VisualPrefs): number {
  return p.reducedMotion ? 0 : 1;
}

export function deathMotesEnabled(p: VisualPrefs): boolean {
  return !p.reducedMotion;
}
