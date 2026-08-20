/**
 * Stacking fixed HUD widgets clear of the bottom bar.
 *
 * `.hud-bar` wraps to more than one line on narrow screens and grows with the
 * HUD scale pref, so anything pinned to the bottom edge has to track its real
 * height rather than assume one. The faction plate solved this first; the
 * minimap needs the same offset, so the measurement lives here and each widget
 * writes it to its own CSS variable.
 */

/** Breathing room between the bar and whatever sits above it. */
export const HUD_BAR_GAP_PX = 8;

/** Fallback when `--ab-safe-bottom` cannot be read (matches the CSS default). */
const DEFAULT_SAFE_BOTTOM = 12;

/**
 * Distance from the viewport bottom that clears the bar. Pure so the
 * arithmetic is testable without a DOM; the observer below supplies the
 * measurements.
 */
export function hudBarOffsetPx(
  safeBottom: number,
  barHeight: number,
  gap: number = HUD_BAR_GAP_PX,
): number {
  const safe = Number.isFinite(safeBottom) && safeBottom > 0
    ? safeBottom
    : DEFAULT_SAFE_BOTTOM;
  const bar = Number.isFinite(barHeight) && barHeight > 0 ? barHeight : 0;
  return safe + bar + gap;
}

/** Current `--ab-safe-bottom` in px, falling back when it cannot be parsed. */
export function readSafeBottomPx(): number {
  if (typeof document === 'undefined') return DEFAULT_SAFE_BOTTOM;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    '--ab-safe-bottom',
  );
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAFE_BOTTOM;
}

export interface HudBarOffset {
  /** Re-measure now — call after showing or hiding the widget. */
  refresh(): void;
  destroy(): void;
}

/**
 * Watch `anchor` (the bottom bar) and hand the clearing offset to `apply`
 * whenever it changes. Safe to call with a null anchor: the offset then
 * reflects the safe area alone.
 */
export function observeHudBarOffset(
  anchor: HTMLElement | null | undefined,
  apply: (px: number) => void,
): HudBarOffset {
  const refresh = () => {
    let barHeight = 0;
    if (anchor && anchor.isConnected && !anchor.hidden) {
      barHeight = anchor.getBoundingClientRect().height;
    }
    apply(hudBarOffsetPx(readSafeBottomPx(), barHeight));
  };

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined' && anchor) {
    resizeObserver = new ResizeObserver(() => refresh());
    resizeObserver.observe(anchor);
  }
  window.addEventListener('resize', refresh);
  refresh();

  return {
    refresh,
    destroy() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      window.removeEventListener('resize', refresh);
    },
  };
}
