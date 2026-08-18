import type { SendMode } from '../input/sendCount';
import type { CommandResult } from '../sim/commands';
import { canPlantKind, type TreeKind, type World } from '../sim/types';
import { getOccupiedSlots } from '../sim/world';
import {
  campaignCompleteCopy,
  commandReasonCopy,
  endLoseCopy,
  endWinCopy,
  factionLabel,
  FIRST_RUN_STEPS,
  FIRST_RUN_STORAGE_KEY,
  inspectorStatLabel,
  plantKindLabel,
  treeKindLockReason,
} from './copy';

const TOAST_MS = 2500;

export interface SessionHud {
  root: HTMLDivElement;
  endOverlay: HTMLDivElement;
  firstRunOverlay: HTMLDivElement;
  setVisible(visible: boolean): void;
  showEnd(opts: {
    outcome: 'won' | 'lost';
    mode: 'skirmish' | 'campaign';
    mapTitle?: string;
    showNext?: boolean;
    campaignComplete?: boolean;
  }): void;
  hideEnd(): void;
  /** Returns true if first-run was shown (sim should stay paused). */
  maybeShowFirstRun(): boolean;
  dismissFirstRun(): void;
  isFirstRunVisible(): boolean;
  showCommandResult(result: CommandResult): void;
  setPlantKind(kind: TreeKind): void;
  setMuted(muted: boolean): void;
  syncSendDock(sendCount: number, sendMode: SendMode): void;
  setFps(fps: number): void;
  sync(
    world: World,
    selectedId: number | null,
    local: number,
    sentinels: number,
    plantKind: TreeKind,
    dragging: boolean,
    sendCount: number,
    sendMode: SendMode,
  ): void;
  destroy(): void;
}

export function createSessionHud(opts: {
  host: HTMLElement;
  onRestart: () => void;
  onNewMap: () => void;
  onNextMap?: () => void;
  onTitle?: () => void;
  onPlantKind: (kind: TreeKind) => void;
  onMuteToggle: () => void;
  onSendScout: () => void;
  onSendPrecise: () => void;
  onSendAll: () => void;
  onSendBump: (delta: number) => void;
  onFirstRunDismiss: () => void;
}): SessionHud {
  const hud = document.createElement('div');
  hud.className = 'hud';
  hud.innerHTML = `
    <div class="hud-bar">
      <div id="hud-census" class="hud-census" aria-label="Field census">
        <span class="hud-chip" data-faction="player"><span class="hud-chip-label">You</span> <span class="hud-chip-value" id="hud-census-player">0</span></span>
        <span class="hud-chip" data-faction="grey"><span class="hud-chip-label">Wild</span> <span class="hud-chip-value" id="hud-census-grey">0</span></span>
        <span class="hud-chip" data-faction="enemy"><span class="hud-chip-label">Enemy</span> <span class="hud-chip-value" id="hud-census-enemy">0</span></span>
        <button type="button" class="hud-mute" id="hud-mute" aria-label="Mute music" aria-pressed="false" title="Mute music (M)">Music on</button>
      </div>
      <div id="hud-inspector" class="hud-inspector" hidden>
        <div class="hud-inspector-title">
          <strong id="hud-inspector-name"></strong>
          <span id="hud-inspector-owner" class="hud-inspector-owner"></span>
        </div>
        <dl class="hud-inspector-stats" id="hud-inspector-stats"></dl>
        <p id="hud-inspector-note" class="hud-inspector-note" hidden></p>
        <p id="hud-inspector-status" class="hud-inspector-status" hidden></p>
      </div>
      <div class="hud-tools">
        <div class="hud-kinds" id="hud-kinds" role="group" aria-label="Tree kind">
          <button type="button" class="hud-kind" data-kind="dyson" title="Dyson tree">1 Dyson</button>
          <button type="button" class="hud-kind" data-kind="energy" title="Energy tree">2 Energy</button>
          <button type="button" class="hud-kind" data-kind="defense" title="Defense tree">3 Defense</button>
        </div>
        <div class="hud-send" id="hud-send" role="group" aria-label="Send count">
          <button type="button" class="hud-send-btn" id="hud-send-scout" data-mode="scout">Scout</button>
          <button type="button" class="hud-send-btn" id="hud-send-precise" data-mode="precise" title="Dial a precise number around the target">Precise</button>
          <button type="button" class="hud-send-btn" id="hud-send-dec" aria-label="Fewer seedlings">−</button>
          <span class="hud-send-count" id="hud-send-count">0</span>
          <button type="button" class="hud-send-btn" id="hud-send-inc" aria-label="More seedlings">+</button>
          <button type="button" class="hud-send-btn" id="hud-send-all" data-mode="all">All</button>
        </div>
      </div>
    </div>
    <div id="hud-fps" class="hud-fps" aria-label="Frame rate"><span id="hud-fps-value">FPS --</span></div>
    <div id="hud-toast" class="hud-toast" hidden></div>
  `;
  opts.host.appendChild(hud);

  const endOverlay = document.createElement('div');
  endOverlay.className = 'end-overlay';
  endOverlay.hidden = true;
  endOverlay.innerHTML = `
    <div class="end-card">
      <p id="end-copy"></p>
      <div class="end-actions">
        <button type="button" id="end-restart">Restart</button>
        <button type="button" id="end-newmap">New map</button>
        <button type="button" id="end-next" hidden>Next map</button>
        <button type="button" id="end-title" hidden>Title</button>
      </div>
    </div>
  `;
  opts.host.appendChild(endOverlay);

  const firstRunOverlay = document.createElement('div');
  firstRunOverlay.className = 'end-overlay first-run-overlay';
  firstRunOverlay.hidden = true;
  const firstRunSteps = FIRST_RUN_STEPS.map((step) => `<li>${step}</li>`).join('');
  firstRunOverlay.innerHTML = `
    <div class="end-card">
      <p class="first-run-title">How to play</p>
      <ol class="first-run-steps">
        ${firstRunSteps}
      </ol>
      <div class="end-actions">
        <button type="button" id="first-run-got-it">Got it</button>
      </div>
    </div>
  `;
  opts.host.appendChild(firstRunOverlay);

  const hudCensusPlayer = hud.querySelector('#hud-census-player')!;
  const hudCensusGrey = hud.querySelector('#hud-census-grey')!;
  const hudCensusEnemy = hud.querySelector('#hud-census-enemy')!;
  const muteBtn = hud.querySelector<HTMLButtonElement>('#hud-mute')!;
  const hudInspector = hud.querySelector<HTMLDivElement>('#hud-inspector')!;
  const hudInspectorName = hud.querySelector('#hud-inspector-name')!;
  const hudInspectorOwner = hud.querySelector('#hud-inspector-owner')!;
  const hudInspectorStats = hud.querySelector('#hud-inspector-stats')!;
  const hudInspectorNote = hud.querySelector<HTMLParagraphElement>('#hud-inspector-note')!;
  const hudInspectorStatus = hud.querySelector<HTMLParagraphElement>('#hud-inspector-status')!;
  const hudToast = hud.querySelector<HTMLDivElement>('#hud-toast')!;
  const fpsValue = hud.querySelector<HTMLSpanElement>('#hud-fps-value')!;
  const kindBtns = [
    ...hud.querySelectorAll<HTMLButtonElement>('.hud-kind'),
  ];
  const sendScoutBtn = hud.querySelector<HTMLButtonElement>('#hud-send-scout')!;
  const sendAllBtn = hud.querySelector<HTMLButtonElement>('#hud-send-all')!;
  const sendPreciseBtn = hud.querySelector<HTMLButtonElement>('#hud-send-precise')!;
  const sendDecBtn = hud.querySelector<HTMLButtonElement>('#hud-send-dec')!;
  const sendIncBtn = hud.querySelector<HTMLButtonElement>('#hud-send-inc')!;
  const sendCountEl = hud.querySelector('#hud-send-count')!;
  const endCopy = endOverlay.querySelector('#end-copy')!;
  const endRestart = endOverlay.querySelector<HTMLButtonElement>('#end-restart')!;
  const endNewMap = endOverlay.querySelector<HTMLButtonElement>('#end-newmap')!;
  const endNext = endOverlay.querySelector<HTMLButtonElement>('#end-next')!;
  const endTitle = endOverlay.querySelector<HTMLButtonElement>('#end-title')!;
  const gotIt = firstRunOverlay.querySelector<HTMLButtonElement>('#first-run-got-it')!;

  let toastTimer: number | null = null;
  let plantKind: TreeKind = 'dyson';
  let lockEnergy: number | null = null;

  const refreshKindButtons = () => {
    for (const btn of kindBtns) {
      const kind = btn.dataset.kind as TreeKind;
      const selected = kind === plantKind;
      btn.classList.toggle('is-selected', selected);
      const locked =
        lockEnergy !== null && !canPlantKind(lockEnergy, kind);
      btn.classList.toggle('is-locked', locked);
      const lock = lockEnergy !== null ? treeKindLockReason(lockEnergy, kind) : null;
      btn.title = lock ?? `${plantKindLabel(kind)} tree`;
    }
  };

  const refreshSendDock = (count: number, mode: SendMode) => {
    sendCountEl.textContent = String(count);
    sendScoutBtn.classList.toggle('is-selected', mode === 'scout');
    sendAllBtn.classList.toggle('is-selected', mode === 'all');
    sendPreciseBtn.classList.toggle('is-selected', mode === 'precise');
    // The count chip carries the precise value too, so the player can see
    // the exact dialed number even when their cursor is offscreen.
    sendCountEl.classList.toggle('is-precise', mode === 'precise');
  };

  const setStatRows = (
    rows: { key: Parameters<typeof inspectorStatLabel>[0]; value: string }[],
  ) => {
    hudInspectorStats.replaceChildren();
    for (const row of rows) {
      const dt = document.createElement('dt');
      dt.textContent = inspectorStatLabel(row.key);
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      hudInspectorStats.append(dt, dd);
    }
  };

  const setNote = (text: string | null) => {
    if (!text) {
      hudInspectorNote.hidden = true;
      hudInspectorNote.textContent = '';
      return;
    }
    hudInspectorNote.hidden = false;
    hudInspectorNote.textContent = text;
  };

  const setStatus = (text: string | null) => {
    if (!text) {
      hudInspectorStatus.hidden = true;
      hudInspectorStatus.textContent = '';
      return;
    }
    hudInspectorStatus.hidden = false;
    hudInspectorStatus.textContent = text;
  };

  endRestart.addEventListener('click', () => opts.onRestart());
  muteBtn.addEventListener('click', () => opts.onMuteToggle());
  endNewMap.addEventListener('click', () => opts.onNewMap());
  endNext.addEventListener('click', () => opts.onNextMap?.());
  endTitle.addEventListener('click', () => opts.onTitle?.());
  sendScoutBtn.addEventListener('click', () => opts.onSendScout());
  sendAllBtn.addEventListener('click', () => opts.onSendAll());
  sendPreciseBtn.addEventListener('click', () => opts.onSendPrecise());
  sendDecBtn.addEventListener('click', () => opts.onSendBump(-1));
  sendIncBtn.addEventListener('click', () => opts.onSendBump(1));
  gotIt.addEventListener('click', () => {
    try {
      localStorage.setItem(FIRST_RUN_STORAGE_KEY, '1');
    } catch {
      /* ignore quota / private mode */
    }
    firstRunOverlay.hidden = true;
    opts.onFirstRunDismiss();
  });

  for (const btn of kindBtns) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind as TreeKind;
      plantKind = kind;
      refreshKindButtons();
      opts.onPlantKind(kind);
    });
  }

  const api: SessionHud = {
    root: hud,
    endOverlay,
    firstRunOverlay,

    setVisible(visible: boolean) {
      hud.hidden = !visible;
      if (!visible) endOverlay.hidden = true;
    },

    showEnd(opts) {
      if (opts.campaignComplete) {
        endCopy.textContent = campaignCompleteCopy();
      } else if (opts.outcome === 'won') {
        endCopy.textContent = endWinCopy(opts.mode, opts.mapTitle);
      } else {
        endCopy.textContent = endLoseCopy();
      }
      endNewMap.hidden = opts.mode === 'campaign';
      endNext.hidden = opts.showNext !== true;
      endTitle.hidden = false;
      endOverlay.hidden = false;
    },

    hideEnd() {
      endOverlay.hidden = true;
    },

    maybeShowFirstRun() {
      let seen = false;
      try {
        seen = localStorage.getItem(FIRST_RUN_STORAGE_KEY) === '1';
      } catch {
        seen = false;
      }
      if (seen) {
        firstRunOverlay.hidden = true;
        return false;
      }
      firstRunOverlay.hidden = false;
      return true;
    },

    dismissFirstRun() {
      firstRunOverlay.hidden = true;
    },

    isFirstRunVisible() {
      return !firstRunOverlay.hidden;
    },

    showCommandResult(result: CommandResult) {
      if (result.ok) return;
      const line = commandReasonCopy(result.reason);
      hudToast.textContent = line;
      hudToast.hidden = false;
      if (toastTimer !== null) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toastTimer = null;
        hudToast.hidden = true;
        hudToast.textContent = '';
      }, TOAST_MS);
    },

    setPlantKind(kind: TreeKind) {
      plantKind = kind;
      refreshKindButtons();
    },

    setMuted(muted: boolean) {
      muteBtn.textContent = muted ? 'Music off' : 'Music on';
      muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      muteBtn.title = muted ? 'Unmute music (M)' : 'Mute music (M)';
    },

    syncSendDock(sendCount, mode) {
      refreshSendDock(sendCount, mode);
    },

    setFps(fps) {
      fpsValue.textContent = `FPS ${Math.round(fps)}`;
    },

    sync(
      world,
      selectedId,
      local,
      sentinels,
      kind,
      dragging,
      sendCount,
      mode,
    ) {
      plantKind = kind;
      refreshSendDock(sendCount, mode);
      const counts = census(world);
      hudCensusPlayer.textContent = String(counts.player);
      hudCensusGrey.textContent = String(counts.grey);
      hudCensusEnemy.textContent = String(counts.enemy);

      const sel = selectedId !== null ? world.asteroids.get(selectedId) : undefined;
      lockEnergy = sel ? sel.stats.energy : null;
      refreshKindButtons();

      if (!sel) {
        hudInspector.hidden = true;
        return;
      }

      hudInspector.hidden = false;
      hudInspectorName.textContent = sel.name;
      hudInspectorOwner.textContent = factionLabel(sel.owner);

      const occupied = getOccupiedSlots(world, sel.id).size;
      const rows: { key: Parameters<typeof inspectorStatLabel>[0]; value: string }[] = [
        { key: 'seedlings', value: String(local) },
      ];
      if (sentinels > 0) {
        rows.push({ key: 'sentinels', value: String(sentinels) });
      }
      rows.push(
        { key: 'minerals', value: String(Math.round(sel.minerals)) },
        {
          key: 'energy',
          value: `${Math.round(sel.energyPool)}/${Math.round(sel.maxEnergyPool)}`,
        },
      );
      if (sel.maxShield > 0) {
        rows.push({ key: 'shield', value: String(Math.round(sel.shield)) });
      }
      rows.push({
        key: 'trees',
        value: `${occupied}/${sel.treeSlots}`,
      });
      setStatRows(rows);

      const lockForKind = treeKindLockReason(sel.stats.energy, kind);
      if (lockForKind) {
        setNote(lockForKind);
      } else {
        const energyLock = treeKindLockReason(sel.stats.energy, 'energy');
        const defenseLock = treeKindLockReason(sel.stats.energy, 'defense');
        if (energyLock && defenseLock) {
          setNote(
            `2 & 3 locked — rock Energy ${Math.round(sel.stats.energy)}`,
          );
        } else if (energyLock) {
          setNote(energyLock);
        } else if (defenseLock) {
          setNote(defenseLock);
        } else {
          setNote(null);
        }
      }

      if (dragging) setStatus(`Sending ${sendCount}`);
      else setStatus(`Plant ${plantKindLabel(kind)}`);
    },

    destroy() {
      if (toastTimer !== null) window.clearTimeout(toastTimer);
      hud.remove();
      endOverlay.remove();
      firstRunOverlay.remove();
    },
  };

  refreshKindButtons();
  return api;
}

function census(world: World): Record<'player' | 'grey' | 'enemy', number> {
  const out = { player: 0, grey: 0, enemy: 0 };
  for (const a of world.asteroids.values()) {
    if (a.owner === 'player' || a.owner === 'grey' || a.owner === 'enemy') {
      out[a.owner] += 1;
    }
  }
  return out;
}
