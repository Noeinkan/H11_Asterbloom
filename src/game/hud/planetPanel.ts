/**
 * Hover panel for a planet's subsurface survey.
 *
 * Opens whenever the cursor is over a rock and lists everything the rock
 * holds: the core reservoir, every subsurface pocket with its remaining
 * stock, and which of those pockets roots are currently drawing from. The
 * row for the pocket (or the core) directly under the cursor is marked, so
 * the panel doubles as the readout for the small subsurface targets that
 * are otherwise hard to hit.
 *
 * Pure DOM and pure data in: the caller passes a plain snapshot, so this
 * module never reaches into the world or the renderer.
 */

import { factionLabel } from './copy';
import type { Asteroid, FactionId, ResourceKind } from '../sim/types';

export interface PocketRow {
  id: number;
  kind: ResourceKind;
  amount: number;
  maxAmount: number;
  /** Resource units per second roots are pulling out right now. */
  drain: number;
  /** True once the pocket has been drained to nothing and is regenerating. */
  depleted: boolean;
}

export interface PlanetSurvey {
  asteroidId: number;
  name: string;
  owner: FactionId;
  coreEnergy: number;
  maxCoreEnergy: number;
  treesPlanted: number;
  treeSlots: number;
  minerals: number;
  pockets: PocketRow[];
  /** Subsurface target under the cursor, highlighted in the list. */
  focus: { target: 'pocket'; pocketId: number } | { target: 'core' } | null;
}

/** Subsurface target the survey should mark, from the hover hit test. */
export type SurveyFocus = PlanetSurvey['focus'];

/**
 * Shape one rock into the panel's view model.
 *
 * Kept out of the DOM factory so the mapping — which pockets exist, which
 * read as depleted, which roots are tapping — can be pinned by tests
 * without a document.
 *
 * `drains` is the live per-pocket extraction map from the simulation; a
 * pocket missing from it simply is not being tapped.
 */
export function surveyPlanet(
  asteroid: Asteroid,
  drains: ReadonlyMap<number, number>,
  treesPlanted: number,
  focus: SurveyFocus,
): PlanetSurvey {
  return {
    asteroidId: asteroid.id,
    name: asteroid.name,
    owner: asteroid.owner,
    coreEnergy: asteroid.coreEnergy,
    maxCoreEnergy: asteroid.maxCoreEnergy,
    treesPlanted,
    treeSlots: asteroid.treeSlots,
    minerals: asteroid.minerals,
    pockets: asteroid.pockets.map((p) => ({
      id: p.id,
      kind: p.kind,
      amount: p.amount,
      maxAmount: p.maxAmount,
      drain: drains.get(p.id) ?? 0,
      // `depletedAt` is the sim's own "ran dry" stamp, cleared the moment
      // regen puts anything back — so this tracks the sim, not a threshold
      // the HUD invented.
      depleted: p.depletedAt !== null,
    })),
    focus,
  };
}

/** True when roots are pulling enough from a pocket to be worth showing. */
export function isTapped(row: PocketRow): boolean {
  return row.drain > DRAIN_EPSILON;
}

export interface PlanetPanel {
  show(screenX: number, screenY: number, survey: PlanetSurvey): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

const KIND_LABEL: Record<ResourceKind, string> = {
  mineral: 'Mineral',
  water: 'Water',
  energy: 'Energy',
};

/**
 * Panel swatches. Deliberately not `resourceKindHex`: that one derives from
 * a per-rock flora palette and drifts with the scene hue, which is right on
 * the disc but would make the same resource read as a different colour from
 * one planet to the next in a DOM list.
 */
const KIND_COLOR: Record<ResourceKind, string> = {
  mineral: '#c89464',
  water: '#84c4d8',
  energy: '#e8c46f',
};

/** Below this the drain reads as rounding noise, not an active tap. */
const DRAIN_EPSILON = 0.005;

function pct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export function createPlanetPanel(host: HTMLElement): PlanetPanel {
  const root = document.createElement('div');
  root.className = 'planet-panel';
  root.dataset.visible = 'false';
  root.setAttribute('role', 'tooltip');
  root.innerHTML = `
    <header class="planet-panel-head">
      <span class="planet-panel-name"></span>
      <span class="planet-panel-owner"></span>
    </header>
    <div class="planet-panel-core">
      <div class="planet-panel-row-top">
        <span class="planet-panel-row-name">Core reservoir</span>
        <span class="planet-panel-row-stock"></span>
      </div>
      <span class="planet-panel-bar"><span class="planet-panel-bar-fill"></span></span>
    </div>
    <ul class="planet-panel-list"></ul>
    <p class="planet-panel-empty">No subsurface pockets detected</p>
    <footer class="planet-panel-foot"></footer>
  `;
  host.appendChild(root);

  const nameEl = root.querySelector<HTMLElement>('.planet-panel-name')!;
  const ownerEl = root.querySelector<HTMLElement>('.planet-panel-owner')!;
  const coreEl = root.querySelector<HTMLElement>('.planet-panel-core')!;
  const coreStockEl = coreEl.querySelector<HTMLElement>('.planet-panel-row-stock')!;
  const coreFillEl = coreEl.querySelector<HTMLElement>('.planet-panel-bar-fill')!;
  const listEl = root.querySelector<HTMLElement>('.planet-panel-list')!;
  const emptyEl = root.querySelector<HTMLElement>('.planet-panel-empty')!;
  const footEl = root.querySelector<HTMLElement>('.planet-panel-foot')!;

  /**
   * Rows are pooled by index rather than rebuilt: the panel re-renders on
   * every pointermove, and a rock's pocket count never changes mid-match,
   * so after the first hover this settles into pure text updates.
   */
  const rows: {
    li: HTMLLIElement;
    name: HTMLElement;
    stock: HTMLElement;
    fill: HTMLElement;
    tap: HTMLElement;
  }[] = [];

  function rowAt(i: number) {
    const existing = rows[i];
    if (existing) return existing;
    const li = document.createElement('li');
    li.className = 'planet-panel-item';
    li.innerHTML = `
      <div class="planet-panel-row-top">
        <span class="planet-panel-swatch"></span>
        <span class="planet-panel-row-name"></span>
        <span class="planet-panel-row-stock"></span>
      </div>
      <span class="planet-panel-bar"><span class="planet-panel-bar-fill"></span></span>
      <span class="planet-panel-tap"></span>
    `;
    listEl.appendChild(li);
    const made = {
      li,
      name: li.querySelector<HTMLElement>('.planet-panel-row-name')!,
      stock: li.querySelector<HTMLElement>('.planet-panel-row-stock')!,
      fill: li.querySelector<HTMLElement>('.planet-panel-bar-fill')!,
      tap: li.querySelector<HTMLElement>('.planet-panel-tap')!,
    };
    li.querySelector<HTMLElement>('.planet-panel-swatch')!.dataset.role = 'swatch';
    rows[i] = made;
    return made;
  }

  function render(survey: PlanetSurvey): void {
    nameEl.textContent = survey.name;
    ownerEl.textContent = factionLabel(survey.owner);
    ownerEl.dataset.faction = survey.owner;

    coreStockEl.textContent = `${survey.coreEnergy.toFixed(1)} / ${survey.maxCoreEnergy.toFixed(0)}`;
    coreFillEl.style.width = `${pct(survey.coreEnergy, survey.maxCoreEnergy).toFixed(1)}%`;
    coreEl.dataset.focus = survey.focus?.target === 'core' ? 'true' : 'false';

    const pockets = survey.pockets;
    emptyEl.hidden = pockets.length > 0;
    for (let i = 0; i < pockets.length; i++) {
      const p = pockets[i]!;
      const row = rowAt(i);
      row.li.hidden = false;
      row.li.dataset.kind = p.kind;
      row.li.dataset.depleted = p.depleted ? 'true' : 'false';
      row.li.dataset.focus =
        survey.focus?.target === 'pocket' && survey.focus.pocketId === p.id
          ? 'true'
          : 'false';
      const swatch = row.li.querySelector<HTMLElement>('[data-role="swatch"]')!;
      swatch.style.background = KIND_COLOR[p.kind];
      row.name.textContent = KIND_LABEL[p.kind];
      row.stock.textContent = `${p.amount.toFixed(1)} / ${p.maxAmount.toFixed(0)}`;
      row.fill.style.width = `${pct(p.amount, p.maxAmount).toFixed(1)}%`;
      row.fill.style.background = KIND_COLOR[p.kind];
      // Depletion is the more urgent state, so it wins the caption even
      // while roots are still tugging at what regenerates.
      row.tap.textContent = p.depleted
        ? 'Depleted — regenerating'
        : isTapped(p)
          ? `Roots tapping · ${p.drain.toFixed(2)}/s`
          : '';
      row.tap.hidden = row.tap.textContent === '';
    }
    for (let i = pockets.length; i < rows.length; i++) rows[i]!.li.hidden = true;

    const tapped = pockets.filter(isTapped).length;
    footEl.textContent =
      `Trees ${survey.treesPlanted}/${survey.treeSlots} · ` +
      `Fertility ${Math.round(survey.minerals)}` +
      (tapped > 0 ? ` · ${tapped} tapped` : '');
  }

  /**
   * Offset from the cursor, then flipped to whichever side has room. Reads
   * the live rect instead of assuming a fixed size — the panel grows with
   * the pocket count.
   */
  function place(screenX: number, screenY: number): void {
    const pad = 12;
    const gap = 18;
    root.style.left = '0px';
    root.style.top = '0px';
    const rect = root.getBoundingClientRect();
    let left = screenX + gap;
    if (left + rect.width > window.innerWidth - pad) {
      left = screenX - gap - rect.width;
    }
    left = Math.max(pad, left);
    let top = screenY - rect.height / 2;
    top = Math.min(window.innerHeight - pad - rect.height, top);
    top = Math.max(pad, top);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  return {
    show(screenX, screenY, survey) {
      render(survey);
      root.dataset.visible = 'true';
      place(screenX, screenY);
    },
    hide() {
      root.dataset.visible = 'false';
    },
    isVisible() {
      return root.dataset.visible === 'true';
    },
    destroy() {
      root.remove();
    },
  };
}
