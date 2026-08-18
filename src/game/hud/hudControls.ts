/**
 * Top-right icon stack: pause/help buttons. Help reopens the first-run
 * overlay; pause opens the existing pause menu. The FPS readout lives in the
 * same stack so it doesn't drift.
 */

export interface HudControls {
  root: HTMLDivElement;
  setVisible(visible: boolean): void;
  setHelpActive(active: boolean): void;
  setPauseActive(active: boolean): void;
  destroy(): void;
}

export function createHudControls(opts: {
  host: HTMLElement;
  onPause: () => void;
  onHelp: () => void;
}): HudControls {
  const root = document.createElement('div');
  root.className = 'hud-controls';
  root.innerHTML = `
    <button type="button" class="hud-icon-btn" id="hud-help" aria-label="Help" title="How to play">?</button>
    <button type="button" class="hud-icon-btn" id="hud-pause" aria-label="Pause" title="Pause (Esc)">||</button>
  `;
  opts.host.appendChild(root);

  const helpBtn = root.querySelector<HTMLButtonElement>('#hud-help')!;
  const pauseBtn = root.querySelector<HTMLButtonElement>('#hud-pause')!;

  helpBtn.addEventListener('click', () => opts.onHelp());
  pauseBtn.addEventListener('click', () => opts.onPause());

  return {
    root,

    setVisible(visible) {
      root.hidden = !visible;
    },

    setHelpActive(active) {
      helpBtn.classList.toggle('is-active', active);
    },

    setPauseActive(active) {
      pauseBtn.classList.toggle('is-active', active);
    },

    destroy() {
      root.remove();
    },
  };
}
