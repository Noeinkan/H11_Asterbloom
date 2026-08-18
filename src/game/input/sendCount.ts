/** Pure send-count helpers — no DOM / Pixi. */

export type SendMode = 'all' | 'scout' | 'half' | 'fixed' | 'precise';

/**
 * Resolve how many seedlings to send given orbiters available and mode.
 * - all: send every ready orbiter
 * - scout: send at most 1
 * - half: send roughly half of the ready orbiters (rounded up, at least 1)
 * - fixed: keep the chosen count, clamped to [0, max]
 * - precise: keep the chosen count, clamped to [0, max] (same as fixed).
 *   The mode flag is just metadata so the dial stays visible after release.
 */
export function resolveSendCount(
  max: number,
  mode: SendMode,
  fixedCount: number,
): number {
  if (max < 1) return 0;
  if (mode === 'scout') return 1;
  if (mode === 'all') return max;
  if (mode === 'half') return Math.max(1, Math.ceil(max / 2));
  return Math.min(max, Math.max(0, fixedCount | 0));
}

/**
 * Clamp a desired exact count to the available orbiters (no mode switching).
 * Returns 0 when no orbiters are available.
 */
export function resolveSendExact(max: number, exact: number): number {
  if (max < 1) return 0;
  return Math.min(max, Math.max(0, exact | 0));
}

/**
 * Bump an exact count by delta, clamped to [0, max]. Used by the slider/+/-
 * controls while the player is fine-tuning a number.
 */
export function adjustSendCount(max: number, current: number, delta: number): number {
  if (max < 1) return 0;
  const next = (current | 0) + (delta | 0);
  return Math.min(max, Math.max(0, next));
}

/**
 * Bump a fixed send count by delta, clamped to [1, max] (or 0 when max < 1).
 * Convenience wrapper around `adjustSendCount` for the legacy -/+ stepper.
 */
export function bumpSendCount(
  max: number,
  current: number,
  delta: number,
): number {
  if (max < 1) return 0;
  const next = Math.min(max, Math.max(1, current + delta));
  return next;
}

/**
 * Snap to the nearest preset for a given amount. Used by the dock to keep the
 * preset chips (`Scout`, `Half`, `All`) in sync with the displayed count.
 */
export function closestPreset(
  max: number,
  count: number,
): 'scout' | 'half' | 'all' | 'fixed' {
  if (max < 1 || count <= 0) return 'fixed';
  if (count >= max) return 'all';
  if (count === 1) return 'scout';
  const half = Math.max(1, Math.ceil(max / 2));
  if (count === half) return 'half';
  return 'fixed';
}

/**
 * Convert a mouse angle (radians, atan2 result) around a target asteroid
 * into a seedling count for the precise-send dial.
 *
 * In Pixi's y-down coordinate space the cursor sits above the target when
 * `atan2(dy, dx)` is `-π/2` (top of dial), and rotates clockwise as the
 * angle grows toward `+π/2` (bottom). We normalize so the dial starts at
 * 12 o'clock and the count grows linearly with the sweep. `max` orbiters
 * occupies one full revolution.
 */
export function countFromDialAngle(max: number, angle: number): number {
  if (max < 1) return 0;
  const TAU = Math.PI * 2;
  let rel = angle + Math.PI / 2; // re-base so 0 = top of dial
  rel = ((rel % TAU) + TAU) % TAU;
  // Map [0, 2π) to [0, max] by integer slice. Using `Math.floor` on the
  // slice index avoids floating-point drift that would otherwise nudge the
  // count down by one (e.g. 1.4999... rounding to 1 when the slice center
  // truly lands at 1.5). The forward mapping is half-open so the
  // wraparound at 2π cleanly yields `max - 1` (the very last slice).
  const slice = TAU / max;
  const idx = Math.floor(rel / slice);
  return Math.min(max, Math.max(0, idx));
}

/**
 * Inverse of `countFromDialAngle`: returns the dial angle (atan2
 * convention, y-down) that corresponds to `count` seedlings out of `max`.
 *
 * Useful for re-laying out the active arc when the dial is redrawn after a
 * programmatic count change. Returns the start angle (12 o'clock, `-π/2`)
 * when there are no orbiters; otherwise sits at the midpoint of the
 * `count`-th slice so the round-trip with `countFromDialAngle` always
 * resolves to `count`.
 */
export function dialAngleForCount(max: number, count: number): number {
  if (max < 1) return 0;
  const n = Math.min(max, Math.max(0, count | 0));
  if (n <= 0) return -Math.PI / 2;
  const slice = (Math.PI * 2) / max;
  // Slice index n occupies the half-open range [n*slice, (n+1)*slice);
  // its midpoint is (n + 0.5) * slice measured from the top of the dial.
  return -Math.PI / 2 + (n + 0.5) * slice;
}

export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  } catch {
    /* ignore */
  }
  return 'ontouchstart' in window;
}
