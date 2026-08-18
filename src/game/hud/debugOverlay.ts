import type { PerfProbe } from './perfProbe';
import type { ResourceKind, Tree, World } from '../sim/types';

function fmt(n: number): string {
  return n.toFixed(2);
}

function intakeText(t: Tree): string {
  const ri = t.rootIntake ?? { mineral: 0, water: 0, energy: 0 };
  return `M${fmt(ri.mineral)} W${fmt(ri.water)} E${fmt(ri.energy)}`;
}

export interface DebugOverlay {
  root: HTMLDivElement;
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  sync(world: World, perf?: PerfProbe): void;
  destroy(): void;
}

/**
 * Frame budget block: wall-clock frame time, the JS half of it, then the
 * heaviest sections. A `GPU BOUND` flag appears when JavaScript finishes in
 * well under half the frame — that means the cost is fill rate / overdraw,
 * not our per-frame work.
 */
function perfBlock(perf: PerfProbe): string {
  const rows = perf
    .rows()
    .filter(([, ms]) => ms >= 0.05)
    .map(
      ([name, ms]) =>
        `<li><span>${name}</span><span>${ms.toFixed(2)} ms</span></li>`,
    )
    .join('');
  const flag = perf.gpuBound()
    ? ' <span class="hud-debug-meta">GPU BOUND</span>'
    : '';
  return (
    `<div class="hud-debug-rock"><div class="hud-debug-rock-head">Frame${flag}</div>` +
    `<ul class="hud-debug-trees">${rows}</ul></div>`
  );
}

/**
 * Playtest overlay (F3): per-rock core reservoir + pocket totals and, for
 * each planted tree, its live rootIntake breakdown. Read-only; the full HUD
 * inspector rewrite is a separate plan.
 */
export function createDebugOverlay(host: HTMLElement): DebugOverlay {
  const root = document.createElement('div');
  root.className = 'hud-debug';
  root.hidden = true;
  host.appendChild(root);

  return {
    root,

    isVisible() {
      return !root.hidden;
    },

    setVisible(visible) {
      root.hidden = !visible;
    },

    sync(world, perf) {
      const rocks = [...world.asteroids.values()].sort((a, b) => a.id - b.id);
      const trees = [...world.trees.values()].sort(
        (a, b) => a.asteroidId - b.asteroidId || a.slotIndex - b.slotIndex,
      );

      const parts = [
        '<div class="hud-debug-title">Resource intake <span>(F3 to hide)</span></div>',
      ];
      if (perf) parts.push(perfBlock(perf));

      for (const a of rocks) {
        const rockTrees = trees.filter((t) => t.asteroidId === a.id);
        const pocketTotal: Record<ResourceKind, number> = {
          mineral: 0,
          water: 0,
          energy: 0,
        };
        for (const p of a.pockets) pocketTotal[p.kind] += p.amount;

        parts.push(
          `<div class="hud-debug-rock">` +
            `<div class="hud-debug-rock-head">${a.name} ` +
            `<span class="hud-debug-meta">core ${fmt(a.coreEnergy)}/${fmt(a.maxCoreEnergy)} · ` +
            `pockets M${fmt(pocketTotal.mineral)} W${fmt(pocketTotal.water)} E${fmt(pocketTotal.energy)}</span></div>`,
        );

        if (rockTrees.length > 0) {
          const items = rockTrees
            .map(
              (t) =>
                `<li>${t.kind}·slot${t.slotIndex} ${intakeText(t)}</li>`,
            )
            .join('');
          parts.push(`<ul class="hud-debug-trees">${items}</ul>`);
        }

        parts.push('</div>');
      }

      root.innerHTML = parts.join('');
    },

    destroy() {
      root.remove();
    },
  };
}
