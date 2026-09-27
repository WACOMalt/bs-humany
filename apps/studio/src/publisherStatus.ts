/**
 * What `pnpm publish:pose` says about its run in the panel's status file, and the settings it
 * builds that run from.
 *
 * Here rather than in the script, so that it is typechecked: the status is a `PanelStatus`, the
 * contract the studio's own link and the training showcase write too, and a field the contract
 * gains or renames fails to compile here instead of going missing from the headset's panel
 * whenever it follows the headless publisher. The script loads this through the same jiti it
 * loads the simulation with.
 *
 * Only types come from the simulation; nothing here runs a body or touches a file.
 */

import type { Morphology } from '@bs-humany/hsdl';
import {
  type PanelScenarioParameter,
  type PanelSettings,
  type PanelStatus,
  type PanelTissue,
  staticBoxJson,
} from '@bs-humany/pose-bridge/codec';
import {
  MUSCLE_GROUPS,
  SCENARIO_DEFINITIONS,
  type Scenario,
  type ScenarioDefinition,
} from '@bs-humany/scenarios';
import type { Simulation } from './simulation.js';

/**
 * Everything the headset's panel can set on the publisher. `null` means "as the scenario says":
 * its morphology, its passive joints, whether it wants muscles. The profile is never null -- it is
 * `--profile`, or the publisher's own default, whichever profile the scenario was written on --
 * and the step rate's null is the profile's own rate. A scenario's parameters are not here: they
 * are kept per scenario, beside these.
 */
export interface PublisherSettings {
  scenario: string;
  profile: string;
  muscles: boolean | null;
  sex: number | null;
  stature: number | null;
  mass: number | null;
  crural: number | null;
  brachial: number | null;
  legLength: number | null;
  passive: boolean | null;
  redistribute: boolean;
  fps: number;
  stepsPerSecond: number | null;
  gravity: boolean;
  floor: boolean;
}

/** The proportions a morphology that names none gets, as the studio's sliders start. */
const DEFAULT_PROPORTIONS = { crural: 1.004, brachial: 0.785, relativeLegLength: 1 };

/** The morphology a build uses: the scenario's, with whatever the panel overrode. */
export function publisherMorphology(
  settings: Readonly<PublisherSettings>,
  scenario: Scenario,
): Morphology {
  const base = scenario.morphology;
  const proportions = { ...DEFAULT_PROPORTIONS, ...(base.proportions ?? {}) };
  return {
    sex: settings.sex ?? base.sex,
    stature: settings.stature ?? base.stature,
    mass: settings.mass ?? base.mass,
    proportions: {
      crural: settings.crural ?? proportions.crural,
      brachial: settings.brachial ?? proportions.brachial,
      relativeLegLength: settings.legLength ?? proportions.relativeLegLength,
    },
  };
}

/** The definition a scenario id names; throws naming the known ones, as `scenario()` does. */
export function scenarioDefinition(id: string): ScenarioDefinition {
  const definition = SCENARIO_DEFINITIONS.find((d) => d.id === id);
  if (!definition) {
    throw new Error(
      `No scenario '${id}'. Known: ${SCENARIO_DEFINITIONS.map((d) => d.id).join(', ')}.`,
    );
  }
  return definition;
}

/**
 * A scenario's parameters as its sliders show them, at the values the run was built with. The
 * unit is trimmed: the definitions keep it as a readout suffix with its own leading space.
 */
export function scenarioParameters(
  definition: ScenarioDefinition,
  values: Readonly<Record<string, number>>,
): PanelScenarioParameter[] {
  return definition.parameters.map((p) => ({
    id: p.id,
    title: p.label,
    value: values[p.id] ?? p.value,
    min: p.min,
    max: p.max,
    step: p.step,
    unit: p.unit.trim(),
  }));
}

/** What the status is built from: the run and what the panel has set around it. */
export interface PublisherRun {
  /** Which run of the bridge files, as the viewer is told. */
  readonly generation: number;
  readonly settings: Readonly<PublisherSettings>;
  readonly profiles: readonly string[];
  readonly definition: ScenarioDefinition;
  /** The scenario the simulation was built from, at `values`. */
  readonly scenario: Scenario;
  readonly values: Readonly<Record<string, number>>;
  readonly simulation: Simulation;
  /** Whether the muscle ring is being written. */
  readonly muscles: boolean;
  /** The connective tissue, which is the articulation's and so the same for the whole build. */
  readonly tissue: PanelTissue;
  readonly wallSeconds: number;
  readonly speed: number;
  readonly paused: boolean;
  readonly holding: readonly string[];
  readonly grabStrength: number;
  /** The muscle groups' sliders, 0 to 100, in `MUSCLE_GROUPS` order. */
  readonly drives: readonly number[];
  readonly overlays: Readonly<Record<string, boolean>>;
}

/** The status file's contents for this run, as the headset's panel reads them. */
export function publisherStatus(run: PublisherRun): PanelStatus {
  const { simulation, scenario, settings } = run;
  const morphology = publisherMorphology(settings, scenario);
  const panelSettings: PanelSettings = {
    muscles: run.muscles,
    sex: morphology.sex,
    stature: morphology.stature,
    mass: morphology.mass,
    crural: morphology.proportions?.crural ?? DEFAULT_PROPORTIONS.crural,
    brachial: morphology.proportions?.brachial ?? DEFAULT_PROPORTIONS.brachial,
    legLength: morphology.proportions?.relativeLegLength ?? DEFAULT_PROPORTIONS.relativeLegLength,
    passive: settings.passive ?? scenario.passiveJoints,
    redistribute: settings.redistribute,
    gravity: settings.gravity,
    floor: settings.floor,
    fps: settings.fps,
    stepsPerSecond: simulation.stepsPerSecond,
  };
  return {
    generation: run.generation,
    scenario: { id: scenario.id, title: scenario.title },
    // Each with its description, which the headset shows under the picker as the desktop does.
    scenarios: SCENARIO_DEFINITIONS.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
    })),
    profiles: run.profiles,
    profile: settings.profile,
    simSeconds: simulation.ticks * simulation.dt,
    wallSeconds: run.wallSeconds,
    speed: run.speed,
    paused: run.paused,
    muscles: run.muscles,
    holding: run.holding,
    grabStrength: run.grabStrength,
    stepsPerSecond: simulation.stepsPerSecond,
    fps: settings.fps,
    settings: panelSettings,
    driveGroups: MUSCLE_GROUPS.map((g, i) => ({
      title: g.title,
      level: run.drives[i] ?? 0,
      section: g.section,
    })),
    mode: run.paused ? 'paused' : 'running',
    overlays: run.overlays,
    scenarioParameters: scenarioParameters(run.definition, run.values),
    // The desktop's readout is text it draws from its own panel; a headless run has none.
    muscleReadout: {},
    tissue: run.tissue,
    tension: muscleTension(simulation),
    // The scenery, which the viewer has no other way to know: the ground's height and every
    // static box, in the simulation's frame.
    groundHeight: scenario.ground.height,
    staticBoxes: (scenario.staticBoxes ?? []).map(staticBoxJson),
    diagnostics: diagnostics(simulation),
  };
}

/** Each unit's tendon force as a fraction of its maximum, for whatever tints muscles. */
export function muscleTension(simulation: Simulation): number[] {
  const state = simulation.muscleState();
  const units = simulation.muscles?.units;
  if (!state || !units) return [];
  return units.map((u, i) => {
    const maximum = u.parameters.maxIsometricForce;
    return Number((maximum > 0 ? (state.tendonForce[i] ?? 0) / maximum : 0).toFixed(3));
  });
}

/** The studio's diagnostics strip, as numbers. */
function diagnostics(simulation: Simulation): PanelStatus['diagnostics'] {
  const energy = simulation.channel('diagnostics.energy').fields;
  const limits = simulation.channel('diagnostics.limits').fields;
  const contacts = simulation.channel('contact.manifolds');
  let worst = 0;
  let violations = 0;
  const proximity = limits.proximity as Float64Array;
  const violation = limits.violation as Uint8Array;
  for (let i = 0; i < proximity.length; i++) {
    worst = Math.max(worst, proximity[i] ?? 0);
    violations += violation[i] ?? 0;
  }
  return {
    kinetic: (energy.kinetic as Float64Array)[0] ?? 0,
    potential: (energy.potential as Float64Array)[0] ?? 0,
    driftMm: ((energy.drift as Float64Array)[0] ?? 0) * 1000,
    limitsWorst: worst,
    violations,
    contacts: contacts.count,
    costMs: simulation.lastStepMs,
  };
}
