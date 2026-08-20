import type { World } from '../sim/types';
import { observeHudBarOffset } from './hudBarOffset';

export interface FactionPlate {
  root: HTMLDivElement;
  setVisible(visible: boolean): void;
  sync(world: World, selectedAsteroidId: number | null): void;
  destroy(): void;
}


/**
 * Always-visible bottom-left "colony name" plate. Names the player's home
 * rock and falls back to the selected rock when the home is destroyed. The
 * plate sits just above the bottom HUD bar; its offset tracks the bar's real
 * height so it stays clear of the inspector even when the bar wraps to
 * multiple lines on narrow screens.
 */
export function createFactionPlate(
  host: HTMLElement,
  anchor?: HTMLElement | null,
): FactionPlate {
  const root = document.createElement('div');
  root.className = 'hud-faction-plate';
  root.hidden = true;
  root.innerHTML = `
    <span class="hud-faction-plate-name"></span>
  `;
  host.appendChild(root);

  const nameEl = root.querySelector<HTMLSpanElement>('.hud-faction-plate-name')!;

  let lastName = '';

  const resolveName = (
    world: World,
    selectedAsteroidId: number | null,
  ): string => {
    let home: { name: string } | undefined;
    for (const a of world.asteroids.values()) {
      if (a.owner === 'player') {
        home = a;
        break;
      }
    }
    if (home) return home.name;
    if (selectedAsteroidId !== null) {
      const sel = world.asteroids.get(selectedAsteroidId);
      if (sel) return sel.name;
    }
    return '';
  };

  const offset = observeHudBarOffset(anchor, (px) => {
    root.style.setProperty('--ab-plate-bottom', `${px}px`);
  });

  return {
    root,

    setVisible(visible) {
      root.hidden = !visible;
      offset.refresh();
    },

    sync(world, selectedAsteroidId) {
      const next = resolveName(world, selectedAsteroidId);
      if (next === lastName) return;
      lastName = next;
      nameEl.textContent = next;
    },

    destroy() {
      offset.destroy();
      root.remove();
    },
  };
}
