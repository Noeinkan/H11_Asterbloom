import {
  CAMPAIGN_MAPS,
  readCampaignIndex,
} from '../sim/campaign';
import type { Difficulty } from '../sim/types';
import { difficultyLabel } from './copy';
import {
  applyHudScale,
  applyReducedMotionClass,
  GAME_VERSION,
  nextHudScale,
  readFactionMarks,
  readHudScale,
  readMinimap,
  readMuted,
  readReducedMotion,
  readScreenFlash,
  writeFactionMarks,
  writeHudScale,
  writeMinimap,
  writeMuted,
  writeReducedMotion,
  writeScreenFlash,
} from './prefs';

export interface TitleHud {
  root: HTMLDivElement;
  show(): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

type TitleView = 'home' | 'skirmish' | 'campaign' | 'settings';

export function createTitleHud(opts: {
  host: HTMLElement;
  onSkirmish: (difficulty: Difficulty) => void;
  onCampaign: (index: number) => void;
  onMuteChange: (muted: boolean) => void;
  /** Any accessibility pref changed; the caller re-reads and re-applies them. */
  onPrefsChange: () => void;
  /** True when a mid-match save exists; decides whether Continue is offered. */
  canContinue?: () => boolean;
  onContinue?: () => void;
}): TitleHud {
  const root = document.createElement('div');
  root.className = 'end-overlay title-overlay';
  root.hidden = true;
  opts.host.appendChild(root);

  let view: TitleView = 'home';
  let muted = readMuted();
  let reducedMotion = readReducedMotion();
  let factionMarks = readFactionMarks();
  let screenFlash = readScreenFlash();
  let minimap = readMinimap();
  let hudScale = readHudScale();

  const render = () => {
    if (view === 'home') {
      // Only offered when there is actually something to resume, so the
      // button never leads to an empty match.
      const resume = opts.canContinue?.()
        ? '<button type="button" data-nav="continue">Continue</button>'
        : '';
      root.innerHTML = `
        <div class="end-card title-card">
          <p class="title-brand">Asterbloom</p>
          <p class="title-tag">Grow. Send. Claim the dark.</p>
          <div class="end-actions title-actions">
            ${resume}
            <button type="button" data-nav="skirmish">Play</button>
            <button type="button" data-nav="campaign">Campaign</button>
            <button type="button" data-nav="settings">Settings</button>
          </div>
          <p class="title-version">v${GAME_VERSION}</p>
        </div>
      `;
    } else if (view === 'skirmish') {
      root.innerHTML = `
        <div class="end-card title-card">
          <p class="first-run-title">Skirmish</p>
          <p class="title-tag">A seeded war. Pick how hard the rival presses.</p>
          <div class="end-actions title-actions">
            <button type="button" data-diff="easy">${difficultyLabel('easy')}</button>
            <button type="button" data-diff="normal">${difficultyLabel('normal')}</button>
            <button type="button" data-diff="hard">${difficultyLabel('hard')}</button>
          </div>
          <div class="end-actions title-actions title-back-row">
            <button type="button" data-nav="home">Back</button>
          </div>
        </div>
      `;
    } else if (view === 'campaign') {
      const last = readCampaignIndex();
      const items = CAMPAIGN_MAPS.map((m, i) => {
        const mark = i === last ? ' is-last' : '';
        return `<button type="button" class="title-map${mark}" data-map="${i}">
          <span class="title-map-n">${i + 1}</span>
          <span class="title-map-body">
            <strong>${m.title}</strong>
            <span>${m.blurb}</span>
          </span>
        </button>`;
      }).join('');
      root.innerHTML = `
        <div class="end-card title-card title-card-wide">
          <p class="first-run-title">Campaign</p>
          <p class="title-tag">Eight authored groves. Pick any map.</p>
          <div class="title-map-list">${items}</div>
          <div class="end-actions title-actions title-back-row">
            <button type="button" data-nav="home">Back</button>
          </div>
        </div>
      `;
    } else {
      root.innerHTML = `
        <div class="end-card title-card">
          <p class="first-run-title">Settings</p>
          <div class="title-settings">
            <button type="button" class="hud-mute" data-pref="mute">
              ${muted ? 'Muted' : 'Sound on'}
            </button>
            <button type="button" class="hud-mute" data-pref="motion">
              ${reducedMotion ? 'Reduced motion on' : 'Reduced motion off'}
            </button>
            <button type="button" class="hud-mute" data-pref="flash">
              ${screenFlash ? 'Screen flash on' : 'Screen flash off'}
            </button>
            <button type="button" class="hud-mute" data-pref="marks">
              ${factionMarks ? 'Faction marks on' : 'Faction marks off'}
            </button>
            <button type="button" class="hud-mute" data-pref="scale">
              HUD size ${Math.round(hudScale * 100)}%
            </button>
            <button type="button" class="hud-mute" data-pref="minimap">
              ${minimap ? 'Minimap on' : 'Minimap off'}
            </button>
          </div>
          <p class="title-version">v${GAME_VERSION}</p>
          <div class="end-actions title-actions title-back-row">
            <button type="button" data-nav="home">Back</button>
          </div>
        </div>
      `;
    }

    root.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nav = btn.dataset.nav;
        if (nav === 'continue') {
          opts.onContinue?.();
          return;
        }
        if (nav === 'skirmish') view = 'skirmish';
        else if (nav === 'campaign') view = 'campaign';
        else if (nav === 'settings') view = 'settings';
        else view = 'home';
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = btn.dataset.diff as Difficulty;
        opts.onSkirmish(d);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-map]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number.parseInt(btn.dataset.map ?? '0', 10);
        opts.onCampaign(i);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-pref]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pref = btn.dataset.pref;
        if (pref === 'mute') {
          muted = !muted;
          writeMuted(muted);
          opts.onMuteChange(muted);
          render();
          return;
        }
        if (pref === 'motion') {
          reducedMotion = !reducedMotion;
          writeReducedMotion(reducedMotion);
          applyReducedMotionClass(reducedMotion);
        } else if (pref === 'flash') {
          screenFlash = !screenFlash;
          writeScreenFlash(screenFlash);
        } else if (pref === 'marks') {
          factionMarks = !factionMarks;
          writeFactionMarks(factionMarks);
        } else if (pref === 'scale') {
          hudScale = nextHudScale(hudScale);
          writeHudScale(hudScale);
          applyHudScale(hudScale);
        } else if (pref === 'minimap') {
          minimap = !minimap;
          writeMinimap(minimap);
        }
        // One channel for every visual pref: the caller re-reads them all and
        // pushes them at the renderer, so no branch here owns render policy.
        opts.onPrefsChange();
        render();
      });
    });
  };

  render();

  return {
    root,
    show() {
      view = 'home';
      muted = readMuted();
      reducedMotion = readReducedMotion();
      factionMarks = readFactionMarks();
      screenFlash = readScreenFlash();
      minimap = readMinimap();
      hudScale = readHudScale();
      render();
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
    isVisible() {
      return !root.hidden;
    },
    destroy() {
      root.remove();
    },
  };
}
