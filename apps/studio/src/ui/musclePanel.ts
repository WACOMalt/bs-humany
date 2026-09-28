/**
 * The Muscles tab: a drive slider for every group in `MUSCLE_GROUPS`, what each group and each
 * body section is pulling with, and the counts under them.
 *
 * The sliders and the readout rows are made at runtime from the same table the headset draws its
 * panel from, so the two offer the same groups at the same ids.
 *
 * The tab's Spine panel, the cord's gains, is not this module's: its sliders are the Brain panel's
 * (`brain.ts`), which hands them to every run it starts, and its picture is `spineActivity.ts`.
 * It sits on this tab because the cord is what the muscles do under whatever drives them, and a
 * person tuning it is watching the muscles, not a policy. It stays in view when muscles are off,
 * where the drive and readout do not: its gains are a setting for the next run, and one set now
 * is the cord that run starts with once muscles are turned back on.
 */

import { ALL_MUSCLE_UNITS } from '@bs-humany/muscle-data';
import {
  type DriveSection,
  MUSCLE_GROUPS,
  applyDriveSliders,
  driveForSlider,
} from '@bs-humany/scenarios';
import type { Simulation } from '@bs-humany/session';
import { must, setText } from './dom.js';

/**
 * The body sections the drive groups fall into, in the order the table first names them: the
 * readout's section rows, and the `section.*` keys the headset is sent.
 */
const DRIVE_SECTIONS: readonly DriveSection[] = [...new Set(MUSCLE_GROUPS.map((g) => g.section))];
/** Each group's section, as an index into `DRIVE_SECTIONS`, resolved once. */
const SECTION_OF_GROUP = Int8Array.from(MUSCLE_GROUPS, (g) => DRIVE_SECTIONS.indexOf(g.section));

/**
 * What the muscles are pulling with, as numbers: every drive group, every body section, and the
 * three counts under them.
 *
 * Data first, so that the desktop's readout and the headset's are the same reading rather than
 * the headset scraping text back off the desktop's page -- which it used to, and which went on
 * sending the last run's numbers after the run had gone, because nothing cleared the text.
 *
 * "Loaded" counts the units whose tendon is carrying anything at all. It earned its place when
 * three of the seven were not: their straight-line paths were shorter than their own resting
 * length, so the tendon never took up. Via points fixed that and the count now reads full at rest,
 * which is exactly why it is worth keeping on screen. Both sides are counted together, as the
 * sliders drive them.
 */
export interface MuscleReadout {
  /** Units in the run. */
  units: number;
  /** Tendon force summed over each drive group's units, newtons, in `MUSCLE_GROUPS` order. */
  readonly groupForce: Float64Array;
  /** The same summed over each section's groups, in `DRIVE_SECTIONS` order. */
  readonly sectionForce: Float64Array;
  loaded: number;
  /** Tendons in contact with a bone: bent over a surface rather than cutting through it. */
  contacts: number;
  /** Units whose equilibrium did not solve cleanly, so the force read for them is a fallback. */
  strained: number;
}

const newtons = (force: number) => `${force.toFixed(0)} N`;
const loadedText = (r: MuscleReadout) => `${r.loaded} of ${r.units} units`;
const wrappingText = (r: MuscleReadout) => `${r.contacts} contact${r.contacts === 1 ? '' : 's'}`;
const strainedText = (r: MuscleReadout) =>
  r.strained === 0 ? 'none' : `${r.strained} of ${r.units} units`;

/**
 * The readout as the headset's panel is sent it: text by key, the keys a `HashMap` on the Rust
 * side, so adding one changes no protocol type.
 *
 * The section rows and the three counts, as the desktop shows them: `section.arm` and the other
 * four sections, then `loaded`, `wrapping` and `strained`. The elbow and knee rows the headset
 * used to be sent, which covered four groups of thirty-five, are gone now that it draws these.
 * With no readout the map is empty and the headset shows its dashes.
 */
export function muscleReadoutText(r: MuscleReadout | null): Record<string, string> {
  if (!r) return {};
  const text: Record<string, string> = {};
  DRIVE_SECTIONS.forEach((section, at) => {
    text[`section.${section.toLowerCase()}`] = newtons(r.sectionForce[at] as number);
  });
  text.loaded = loadedText(r);
  text.wrapping = wrappingText(r);
  text.strained = strainedText(r);
  return text;
}

export interface MusclePanelHost {
  /** The run of this page's own, whose drive module the sliders set. */
  simulation(): Simulation | null;
}

export interface MusclePanel {
  /** The drive sliders, by group id. */
  readonly driveInputs: ReadonlyMap<string, HTMLInputElement>;
  /** Push every slider into the drive module. Safe to call before a run, and on every change. */
  applyMuscleDrive(sim: Simulation | null | undefined): void;
  /** The readout the frame loop last took, or null with no run or no muscles in it. */
  readonly readout: MuscleReadout | null;
  /** What the muscles are pulling with, on the Muscles tab and beside each slider. */
  update(sim: Simulation): void;
  /**
   * No readout: dashes on every row and nothing beside the sliders. For no run, a run without
   * muscles, and a followed bridge, none of which this page can read muscles off -- where the
   * readout used to go on showing the last run's numbers, to the page and to the headset.
   */
  clear(): void;
  /** Dim the readout and say which frame it is of, while the playhead is off the live edge. */
  showLive(stale: boolean, caption: string): void;
  /**
   * The Muscles tab with the Muscles box unticked: the drive and readout panels go, and a line
   * says why and offers the box back.
   *
   * The whole tab used to go blank, which reads as a tab that failed to load; the box itself is on
   * the Scene tab, out of sight. The headset's Muscles panel says the same thing in the same place.
   */
  showMusclesOff(musclesOn: boolean): void;
}

export function createMusclePanel(host: MusclePanelHost): MusclePanel {
  const drives = must<HTMLDivElement>('#muscle-drives');
  const readoutList = must<HTMLElement>('#muscle-readout');
  const readoutNote = must<HTMLElement>('#muscle-readout-note');
  const loadedRow = must<HTMLElement>('#muscle-loaded');
  const wrappingRow = must<HTMLElement>('#muscle-wrapping');
  const strainedRow = must<HTMLElement>('#muscle-strained');

  // The drive groups and their sliders, one an entry of `MUSCLE_GROUPS`, generated so the studio
  // and the headset's panel offer the same groups at the same ids.
  const driveInputs = new Map<string, HTMLInputElement>();
  const sections = new Map<string, HTMLElement>();
  for (const group of MUSCLE_GROUPS) {
    let section = sections.get(group.section);
    if (!section) {
      const details = window.document.createElement('details');
      details.open = false;
      const summary = window.document.createElement('summary');
      summary.textContent = group.section;
      details.append(summary);
      drives.append(details);
      sections.set(group.section, details);
      section = details;
    }
    // The shared control layout, compact because there are thirty-five of them: the label and
    // its level on one line and the slider under it, as Body > Stature has them, with what the
    // group is pulling with beside the level so a slider says what it is doing as well as what
    // it is asking for.
    const control = window.document.createElement('div');
    control.className = 'control compact';
    const label = window.document.createElement('label');
    label.htmlFor = group.id;
    const readout = window.document.createElement('output');
    readout.id = `${group.id}-value`;
    readout.textContent = '0%';
    const force = window.document.createElement('span');
    force.id = `${group.id}-force`;
    force.className = 'force';
    force.title = 'What this group is pulling with at the newest frame, both sides summed';
    label.append(`${group.title} `, force, readout);
    const input = window.document.createElement('input');
    input.type = 'range';
    input.id = group.id;
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = '0';
    control.append(label, input);
    section.append(control);
    driveInputs.set(group.id, input);
  }

  // The section rows, made from the same table as the sliders and put above the three counts.
  const sectionReadouts: HTMLElement[] = [];
  {
    const first = readoutList.firstElementChild;
    for (const section of DRIVE_SECTIONS) {
      const term = window.document.createElement('dt');
      term.textContent = section;
      term.title =
        `Tendon force summed over every drive group in the ${section.toLowerCase()} section, ` +
        'both sides';
      const value = window.document.createElement('dd');
      value.id = `muscle-section-${section.toLowerCase()}`;
      value.textContent = '—';
      readoutList.insertBefore(term, first);
      readoutList.insertBefore(value, first);
      sectionReadouts.push(value);
    }
  }
  /** Each slider's force readout, in `MUSCLE_GROUPS` order, found once. */
  const groupReadouts = MUSCLE_GROUPS.map((g) => must<HTMLElement>(`#${g.id}-force`));
  /**
   * The whole newtons each row last showed, so a row's text is made and written only when the
   * number on it changes: forty rows of formatting sixty times a second was most of what the
   * readout cost, and most frames change few of them. NaN is "shows a dash", which no reading is.
   */
  const shownGroupForce = new Float64Array(MUSCLE_GROUPS.length).fill(Number.NaN);
  const shownSectionForce = new Float64Array(DRIVE_SECTIONS.length).fill(Number.NaN);
  /** Loaded, contacts, strained and units, as last shown. */
  const shownCounts = new Float64Array(4).fill(Number.NaN);

  /** The readout the frame loop last took, or null with no run or no muscles in it. */
  let muscleReadout: MuscleReadout | null = null;
  /** The one readout every frame fills, so taking it allocates nothing. */
  const readoutScratch: MuscleReadout = {
    units: 0,
    groupForce: new Float64Array(MUSCLE_GROUPS.length),
    sectionForce: new Float64Array(DRIVE_SECTIONS.length),
    loaded: 0,
    contacts: 0,
    strained: 0,
  };
  /**
   * Each unit's drive group, as an index into `MUSCLE_GROUPS` or -1 for a unit in none, built
   * once a run and kept by the identity of that run's unit list. The table lists groups by unit
   * id; the readout used to ask every group whether it held every unit, every frame --
   * thirty-five `includes` over a handful of ids for each of 272 units, sixty times a second.
   */
  let unitGroups: { units: readonly { readonly id: string }[]; group: Int16Array } | undefined;
  const groupOfUnits = (units: readonly { readonly id: string }[]): Int16Array => {
    if (unitGroups?.units !== units) {
      const byId = new Map<string, number>();
      MUSCLE_GROUPS.forEach((group, at) => {
        for (const id of group.units) byId.set(id, at);
      });
      unitGroups = { units, group: Int16Array.from(units, (u) => byId.get(u.id) ?? -1) };
    }
    return unitGroups.group;
  };

  /**
   * Take the readout off the run's newest tick, in one pass over the units, into the scratch
   * readout. Null when the run has no muscles or they have not published yet.
   *
   * Summed per driven group, and nothing outside one is counted. Before the shoulder set arrived
   * "not a flexor" meant "an extensor"; now it would mean the deltoid too, and the readout would
   * say a hanging arm's extensors were pulling ten kilonewtons.
   */
  const muscleReadoutOf = (sim: Simulation): MuscleReadout | null => {
    const state = sim.muscleState();
    const units = sim.muscles?.units;
    if (!state || !units) return null;
    const group = groupOfUnits(units);
    const out = readoutScratch;
    out.groupForce.fill(0);
    out.sectionForce.fill(0);
    let loaded = 0;
    let strained = 0;
    for (let i = 0; i < units.length; i++) {
      const force = state.tendonForce[i] ?? 0;
      if (force > 0) loaded++;
      if ((state.diagnostic[i] ?? 0) !== 0) strained++;
      const at = group[i] as number;
      if (at >= 0) out.groupForce[at] = (out.groupForce[at] as number) + force;
    }
    for (let at = 0; at < MUSCLE_GROUPS.length; at++) {
      const section = SECTION_OF_GROUP[at] as number;
      if (section >= 0) {
        out.sectionForce[section] =
          (out.sectionForce[section] as number) + (out.groupForce[at] as number);
      }
    }
    out.units = units.length;
    out.loaded = loaded;
    out.strained = strained;
    out.contacts = sim.musclePath?.contactCount ?? 0;
    return out;
  };

  /** Write one row's newtons, when the whole number on it has changed. */
  const showForce = (element: HTMLElement, force: number, shown: Float64Array, at: number) => {
    const rounded = Math.round(force);
    if (shown[at] === rounded) return;
    shown[at] = rounded;
    element.textContent = newtons(rounded);
  };

  const clear = (): void => {
    if (muscleReadout === null && Number.isNaN(shownCounts[3] as number)) return;
    muscleReadout = null;
    shownGroupForce.fill(Number.NaN);
    shownSectionForce.fill(Number.NaN);
    shownCounts.fill(Number.NaN);
    for (const element of groupReadouts) element.textContent = '';
    for (const element of sectionReadouts) element.textContent = '—';
    for (const element of [loadedRow, wrappingRow, strainedRow]) element.textContent = '—';
  };

  const applyMuscleDrive = (sim: Simulation | null | undefined): void => {
    const drive = sim?.muscleDrive;
    if (!drive) return;
    applyDriveSliders(drive, (group) => Number(driveInputs.get(group.id)?.value ?? 0));
  };

  for (const slider of driveInputs.values()) {
    const level = must<HTMLElement>(`#${slider.id}-value`);
    slider.addEventListener('input', () => {
      const drive = driveForSlider(Number(slider.value));
      level.textContent =
        drive > 0 && drive < 0.01 ? `${(drive * 100).toFixed(1)}%` : `${Math.round(drive * 100)}%`;
      applyMuscleDrive(host.simulation());
    });
  }

  // How many units a body has, from the table the runs are built from, rather than a number
  // written into the page that went stale with the next muscle added.
  must<HTMLElement>('#muscle-unit-count').textContent = String(ALL_MUSCLE_UNITS.length);

  const offNote = must<HTMLElement>('#muscles-off');
  const panels = [...window.document.querySelectorAll<HTMLElement>('#muscle-control > .panel')];

  return {
    driveInputs,
    applyMuscleDrive,
    get readout() {
      return muscleReadout;
    },
    update(sim) {
      const r = muscleReadoutOf(sim);
      if (!r) {
        clear();
        return;
      }
      muscleReadout = r;
      for (let at = 0; at < groupReadouts.length; at++) {
        showForce(
          groupReadouts[at] as HTMLElement,
          r.groupForce[at] as number,
          shownGroupForce,
          at,
        );
      }
      for (let at = 0; at < sectionReadouts.length; at++) {
        const element = sectionReadouts[at] as HTMLElement;
        showForce(element, r.sectionForce[at] as number, shownSectionForce, at);
      }
      if (shownCounts[0] !== r.loaded || shownCounts[3] !== r.units) {
        loadedRow.textContent = loadedText(r);
      }
      // How many tendons are in contact with a bone right now. A muscle that is wrapping has its
      // path bent over a surface rather than cutting through it, so this is also the quickest way
      // to tell whether the overlay's curves are curves.
      if (shownCounts[1] !== r.contacts) wrappingRow.textContent = wrappingText(r);
      // Units whose equilibrium did not solve cleanly. It is on screen rather than in a log
      // because it is the one number that says "the force you are reading is a fallback": a
      // muscle whose path is longer than its parameters expect sits at the top of its tendon
      // curve, where the model holds it rather than extrapolating, and the force it reports is
      // the cap.
      if (shownCounts[2] !== r.strained || shownCounts[3] !== r.units) {
        strainedRow.textContent = strainedText(r);
      }
      shownCounts[0] = r.loaded;
      shownCounts[1] = r.contacts;
      shownCounts[2] = r.strained;
      shownCounts[3] = r.units;
    },
    clear,
    showLive(stale, caption) {
      readoutList.classList.toggle('stale', stale);
      drives.classList.toggle('forces-stale', stale);
      setText(readoutNote, caption);
      if (readoutNote.hidden !== !stale) readoutNote.hidden = !stale;
    },
    showMusclesOff(musclesOn) {
      const off = !musclesOn;
      for (const panel of panels) panel.hidden = off;
      offNote.hidden = !off;
    },
  };
}
