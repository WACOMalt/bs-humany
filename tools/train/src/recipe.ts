/**
 * The training recipe: what a checkpoint is trained in, and every default, limit and rule that
 * says what a recipe may be.
 *
 * One home, because there used to be four. The rig had the types and the cord's defaults, the
 * dashboard had its own copy of every default and every cap -- one of which had fallen behind the
 * cord by a factor of forty, so a run started from the studio quietly trained a different body
 * from the one the sliders showed -- the command line had a third set, and the studio a fourth.
 * Each was right when it was written; none was told when another changed.
 *
 * So this module imports nothing that runs but the name rule beside it, which imports nothing at
 * all; everything else it takes from other packages is a type. The rig re-exports all of it, the
 * dashboard and the command-line scripts load it through jiti without loading MuJoCo or the
 * kernel, and the studio's main thread imports it without pulling in the rig.
 */

import type { Morphology } from '@bs-humany/hsdl';
import type { SpinalGains, SpinalRegion } from '@bs-humany/modules-nerves';

// The one value import, and a leaf: a plain script with no imports of its own, kept in JavaScript
// so the Node scripts can read the name rule without a loader. Re-exported, so a caller of this
// module never needs to know it is a separate file.
import { CHECKPOINT_NAME, checkpointNameProblem, isCheckpointName } from './checkpointName.mjs';

export { CHECKPOINT_NAME, checkpointNameProblem, isCheckpointName };

/** A number a recipe may hold, from `min` to `max` inclusive. */
export interface Limit {
  readonly min: number;
  readonly max: number;
}

// ---------------------------------------------------------------------------------------------
// What is trained

/**
 * What a run is scored on: `stand` (still, cheap, up) or `balance` (the head still and level).
 *
 * Checked wherever a task arrives, because a task the rig does not know is not refused by the rig:
 * it scores it as a stand, trains, and saves a checkpoint labelled with the task that was never
 * trained. `walk` used to be accepted this way and had a clip picked for it, and never scored a
 * single step of walking.
 */
export const TASKS = ['stand', 'balance'] as const;
export type Task = (typeof TASKS)[number];

/**
 * What a run is scored on when nothing names a task: `balance`, the task of the one behaviour the
 * studio ships (`DEFAULT_BEHAVIOUR`). Not `TASKS[0]`, which is only the order they are listed in.
 */
export const DEFAULT_TASK: Task = 'balance';

/** Whether `t` is a task the rig scores. */
export function isTask(t: unknown): t is Task {
  return typeof t === 'string' && (TASKS as readonly string[]).includes(t);
}

/** The profiles a run may train on, coarsest first. L3 is the reference and the default. */
export const PROFILES = ['l0_ragdoll', 'l1_standard', 'l2_biomechanical', 'l3_anatomical'] as const;
export const DEFAULT_PROFILE = 'l3_anatomical';

/**
 * The reference body: the one the flags train, and the one a request that names no body gets.
 * These are the morphology's inputs, not measurements -- `@bs-humany/anthropometry` resolves them
 * into a body and carries the sources for what they resolve to.
 */
export const REFERENCE_MORPHOLOGY: Morphology = { sex: 0.5, stature: 1.7, mass: 70 };

/**
 * What a request may ask of the body. Not anatomy -- anthropometry resolves and cites the body --
 * but the range a request is held to before it reaches it, wide enough for any adult and narrow
 * enough that a typo is not a three-metre body the rig then spends a run failing to stand.
 */
export const MORPHOLOGY_LIMITS: {
  readonly sex: Limit;
  readonly stature: Limit;
  readonly mass: Limit;
} = {
  sex: { min: 0, max: 1 },
  stature: { min: 1, max: 2.5 },
  mass: { min: 20, max: 300 },
};

/**
 * How much of the drive the brain has, 0 to 1, when nothing says: a third or so of it, so the
 * feedforward and the cord under the brain still carry the body while the policy is learning.
 */
export const DEFAULT_AUTHORITY = 0.3;
export const AUTHORITY_LIMIT: Limit = { min: 0, max: 1 };

// ---------------------------------------------------------------------------------------------
// The loop: what plays under the brain, how noisy it is, and the cord

/**
 * What drives the muscles under the brain: a clip by id, the scenario's own script, or nothing.
 * The scenario's script always runs for what it does to the world -- a floor that tilts, a hand
 * that grabs -- and only its muscle drive is gated by this.
 */
export type Feedforward =
  | { readonly kind: 'clip'; readonly clip: string }
  | { readonly kind: 'script' }
  | { readonly kind: 'none' };

/**
 * How noisy the loop is: the tremor on the muscles, the grain on the senses, and how long one
 * push of the tremor lasts.
 *
 * Both ends, because a silent loop trains a policy that has nothing to answer. Saved with the
 * checkpoint like everything else in the recipe, so a run can be repeated and a studio can say
 * what the brain was brought up in.
 */
export interface NoiseLevels {
  /** Standard deviation of the wander on each drive output, in excitation. */
  readonly motor: number;
  /** Standard deviation of the grain on each observation, in the observation's own units. */
  readonly sense: number;
  /** Correlation time of the wander, in seconds. */
  readonly tau: number;
}

/** What a body is brought up in when a recipe says nothing: a tremor it must ride, and a sense
 * it cannot fully trust. Small enough that a policy can still stand, large enough that no two
 * episodes are the same and no two candidates score the same by accident. */
export const DEFAULT_NOISE: NoiseLevels = { motor: 0.05, sense: 0.01, tau: 0.25 };

/**
 * How noisy a request may make the loop. The tremor and the grain are capped well below the
 * authority a policy has, because noise that drowns the controller is not a disturbance to ride,
 * it is a body that cannot be controlled at all. The tremor's correlation time runs from a
 * hundredth of a second, about one control step, to five seconds, about an episode.
 */
export const NOISE_LIMITS: {
  readonly motor: Limit;
  readonly sense: Limit;
  readonly tau: Limit;
} = {
  motor: { min: 0, max: 0.5 },
  sense: { min: 0, max: 0.5 },
  tau: { min: 0.01, max: 5 },
};

/**
 * The cord under the brain: how hard the stretch reflex answers, how much its antagonist is
 * inhibited, and how long the loop takes. `stretch` at 0 is a body with no reflexes at all,
 * which is what every checkpoint before the spinal module was trained in.
 *
 * The spinal module's own gains, by name rather than by copy: this used to be an interface of its
 * own with the same seven fields, and two interfaces that happen to agree are two that can stop
 * agreeing without either saying so. `SpinalGains` documents what each number is.
 */
export type ReflexLevels = SpinalGains;

/** The cord's seven numbers, in the order the studio and the command line list them. */
export const REFLEX_FIELDS = [
  'stretch',
  'velocity',
  'setPoint',
  'inhibition',
  'forceCeiling',
  'forceInhibition',
  'delaySeconds',
] as const satisfies readonly (keyof ReflexLevels)[];

/**
 * The parts of the body the stretch gain can differ between, in the order the Spine panel lists
 * them: the spinal module's `SPINAL_REGIONS`, kept here as well because this module loads nothing
 * that runs, and held to it by a test. A cord's `regionStretch` is keyed by these.
 */
export const REFLEX_REGIONS = [
  'Arm',
  'Hand',
  'Leg',
  'Trunk',
  'Neck',
] as const satisfies readonly SpinalRegion[];

/**
 * The stretch gain a unit of `region` answers with under `cord`: the region's own when the cord
 * gives one, the base `stretch` when not. So a cord with only `stretch`, as every recipe,
 * checkpoint and session before 2026-09-27 has, is that stretch everywhere.
 */
export function regionStretchOf(cord: ReflexLevels, region: SpinalRegion): number {
  const own = cord.regionStretch?.[region];
  return own !== undefined && Number.isFinite(own) ? own : cord.stretch;
}

/**
 * Whether a cord is off: every stretch gain, the base and each region's, and the damping at
 * zero. The spinal module's own test for it, in the words a recipe line uses.
 */
export function cordIsOff(cord: ReflexLevels): boolean {
  return (
    cord.velocity === 0 &&
    cord.stretch === 0 &&
    REFLEX_REGIONS.every((r) => regionStretchOf(cord, r) === 0)
  );
}

/**
 * The cord with every region's stretch written out, the base's where the cord gives none: the form
 * two cords are compared in, so a file with only `stretch` and one with that stretch in every
 * region read as the same cord, which they are.
 */
export function everyRegion(cord: ReflexLevels): ReflexLevels {
  return {
    ...cord,
    regionStretch: Object.fromEntries(REFLEX_REGIONS.map((r) => [r, regionStretchOf(cord, r)])),
  };
}

/** Whether a cord gives every region the same stretch, its base: one stretch everywhere. */
export function isUniformStretch(cord: ReflexLevels): boolean {
  return REFLEX_REGIONS.every((r) => regionStretchOf(cord, r) === cord.stretch);
}

/**
 * A cord as two cords are compared, number by number. When both give every region the same
 * stretch, the stretch is one number, as it always was, and a change to it is one change. When
 * either differs by region, each region's stretch is written out, the base's where the cord names
 * none, and the base itself is left out: it is only a region's gain where the region follows it,
 * and that is in the region's number already. So a file with one stretch reads against a cord by
 * region as the regions that moved, and a base that no region uses is no difference.
 */
export function comparableCord(cord: ReflexLevels, byRegion: boolean): Record<string, unknown> {
  const { regionStretch: _, stretch, ...rest } = cord;
  if (!byRegion) return { stretch, ...rest };
  return { ...rest, regionStretch: everyRegion(cord).regionStretch };
}

/**
 * The stretch in words: one number when every region has the same, otherwise each region's, as in
 * `arm 2, hand 2, leg 8.5, trunk 8.5, neck 5`.
 */
export function describeStretch(cord: ReflexLevels): string {
  const each = REFLEX_REGIONS.map((r) => regionStretchOf(cord, r));
  if (each.every((v) => v === each[0])) return String(each[0]);
  return REFLEX_REGIONS.map((r, i) => `${r.toLowerCase()} ${each[i]}`).join(', ');
}

/**
 * The cord a run gets unless it says otherwise. Every number is measured; see
 * `docs/validation/reflex-gains.md` for the tables and `SpinalGains` for what each one is.
 *
 * The stretch differs by region, the owner's decision of 2026-09-27, because one stretch of 8.5
 * everywhere made the arms shake: on the default scene the arm joints' tremor was more than three
 * times what it is with no cord. Each region's gain was chosen by one rule over a sweep of that
 * region with the others at 5, on the default behaviour's scene: the smallest gain whose tremor,
 * under `balance` and with no policy, stays within 20% of the region's tremor with its own cord
 * off and whose time upright is within 2% of the region's best; and where no gain keeps both,
 * the one inside the tremor bound that keeps the body up longest. So the trunk, where the cord
 * makes no tremor and buys time upright, has 8.5; the arms and the legs, where it buys time
 * upright and shakes them in proportion, have 3.5, the most they take within the tremor bound; the
 * hands and the neck, where it buys nothing measurable either way, have none of their own spindle
 * gain, and the damping still answers there. The base, 3.5, is what the Stretch slider for all
 * regions opens on, and no region follows it: every region is named.
 *
 * Against 8.5 everywhere, the arms' tremor falls from 4.2 to 1.5 rad/s and the body is up 0.59 s
 * under `balance` against 0.73 -- the legs' stiffness is what that costs, and whether to buy it
 * back at the price of the legs' tremor is the owner's to decide (reflex-gains.md). Before regions
 * the stretch was 8.5, the smallest gain within 1% of where time upright levelled off under the
 * retired standing policy; before that, 3.5; and before that a set of numbers worth nothing,
 * because the afferent it answered was normalised twice and read every muscle in the body as
 * hugely stretched at every instant.
 */
export const DEFAULT_REFLEX: ReflexLevels = {
  stretch: 3.5,
  velocity: 0.25,
  setPoint: 0,
  inhibition: 0.3,
  forceCeiling: 1.2,
  forceInhibition: 0.5,
  delaySeconds: 0.03,
  regionStretch: { Arm: 3.5, Hand: 0, Leg: 3.5, Trunk: 8.5, Neck: 0 },
};

/**
 * A body with the cord switched off: what the checkpoints before the reflexes were trained in.
 * The same numbers as the spinal module's own `DEFAULT_SPINAL_GAINS`, which is the module's off,
 * and a test holds the two together field by field. Written out rather than spread from the
 * default, because the default's stretch by region would come with it and keep the cord on.
 */
export const NO_REFLEX: ReflexLevels = {
  stretch: 0,
  velocity: 0,
  setPoint: DEFAULT_REFLEX.setPoint,
  inhibition: DEFAULT_REFLEX.inhibition,
  forceCeiling: DEFAULT_REFLEX.forceCeiling,
  forceInhibition: DEFAULT_REFLEX.forceInhibition,
  delaySeconds: DEFAULT_REFLEX.delaySeconds,
};

/**
 * How far a request may set the cord. These are safety bounds, not advice -- the advice is
 * `DEFAULT_REFLEX` and the tables behind it -- and they must never be tighter than a slider that
 * sends them, or a value the person chose is quietly swapped for another and the checkpoint
 * records a body nobody asked for. That is exactly what happened when the stretch cap here was a
 * fifth, left from the scale the afferent had before it was fixed, and the studio's slider went
 * to eight.
 *
 * - `stretch` 0 to 10, the range of the studio's `#spine-stretch` slider and the headset's
 *   (`CONTROL_RANGES` in packages/scenarios/src/controls.ts), and of each region's stretch, whose
 *   sliders have the same bounds. Ten is the top of the sweeps that chose the defaults, not a
 *   target.
 * - `velocity` 0 to 10. Past 2 a delayed length loop rings plainly, so the top of this is there
 *   to be measured, not used.
 * - `setPoint` half an optimal length either way: past that the loop either answers a body that
 *   is standing still or never answers at all.
 * - `inhibition` 0 to 1, a share of the antagonist's drive.
 * - `forceCeiling` and `forceInhibition` 0 to 5, a tendon load in maximum isometric forces and a
 *   gain on the load past it; the ceiling is never reached in a fall, so this is room, not use.
 * - `delaySeconds` 0 to 0.2, because past a fifth of a second the loop is not a reflex arc, it is
 *   a correspondence.
 */
export const REFLEX_LIMITS: { readonly [K in keyof ReflexLevels]: Limit } = {
  stretch: { min: 0, max: 10 },
  velocity: { min: 0, max: 10 },
  setPoint: { min: -0.5, max: 0.5 },
  inhibition: { min: 0, max: 1 },
  forceCeiling: { min: 0, max: 5 },
  forceInhibition: { min: 0, max: 5 },
  delaySeconds: { min: 0, max: 0.2 },
};

/**
 * Context units a policy may carry between control steps. Capped because every one of them is a
 * row and a column of new weights, and the search's cost grows with the length of the vector it
 * is searching.
 */
export const MEMORY_LIMIT: Limit = { min: 0, max: 64 };

// ---------------------------------------------------------------------------------------------
// The search

/**
 * The search's own settings when a run does not name them: the step it takes in weight space and
 * how far it trusts it, the network between the body's senses and its drives, how many seeded
 * episodes score a candidate, and how long each is.
 */
export const SEARCH_DEFAULTS = {
  sigma: 0.03,
  learningRate: 0.005,
  hidden: [32, 32] as readonly number[],
  seeds: 2,
  seconds: 6,
} as const;

/**
 * How long and how wide a run is, by where it was started. Two answers on purpose: a run from the
 * command line is usually a measurement or a check and wants to come back the same afternoon, and
 * a run from the studio's Brain tab is usually the one meant to be kept, started and left.
 * Unifying them would make one of the two wrong.
 */
export const CLI_RUN_DEFAULTS = { generations: 300, population: 32 } as const;
export const UI_RUN_DEFAULTS = { generations: 600, population: 64 } as const;

// ---------------------------------------------------------------------------------------------
// The recipe

/**
 * What a checkpoint was trained in, saved with it so the studio can set itself up the same way
 * before handing over: the scenario and its parameter values, the body, and what played under
 * the brain.
 */
export interface TrainingRecipe {
  /** The checkpoint's name: the file it is saved as, and the run files' prefix. */
  readonly name: string;
  /**
   * The timescale it was trained at: ticks a second, and ticks between policy evaluations.
   *
   * Written by the trainer rather than asked for, because both follow from the profile. A run
   * that plays the checkpoint at another step rate is not the physics it learned -- contacts
   * and the muscles' own dynamics both change with the timestep -- and a run that evaluates it
   * at another rate is not the controller it learned either. The studio sets itself to these
   * when a checkpoint is chosen.
   */
  readonly stepsPerSecond?: number;
  readonly controlDivisor?: number;
  /**
   * What it was scored on. A string rather than a `Task`, so that a file written before the task
   * list was checked still reads; `checkRecipe` says when it is not one.
   */
  readonly task: string;
  /** A scenario id from `SCENARIO_DEFINITIONS`; empty for the reference stand on the ground. */
  readonly scenario: string;
  readonly parameters: Readonly<Record<string, number>>;
  readonly profile: string;
  readonly morphology: Morphology;
  readonly passive: boolean;
  readonly redistribute: boolean;
  readonly feedforward: Feedforward;
  readonly authority: number;
  /** The tremor and the grain it was brought up in; `DEFAULT_NOISE` when a recipe omits them. */
  readonly noise?: NoiseLevels;
  /** The cord it was brought up over; `NO_REFLEX` when a recipe omits it, as the old ones do. */
  readonly reflex?: ReflexLevels;
  /** Context units the policy carried between control steps; 0 when a recipe omits it. */
  readonly memory?: number;
}

export interface RigOptions {
  readonly profileId: string;
  /** Hidden layer widths; the input and output are the body's. */
  readonly hidden: readonly number[];
  readonly seconds: number;
  /** Ticks between policy evaluations; a hundred hertz at the profile's rate when not given. */
  readonly controlDivisor?: number;
  readonly authority: number;
  /** What is scored: `stand` (still, cheap, up) or `balance` (the head still and level). */
  readonly task?: string;
  /** What plays under the brain. */
  readonly feedforward: Feedforward;
  /** The scenario the body starts in: placement, ground, scenery; the reference stand when absent. */
  readonly scenario?: {
    readonly id: string;
    readonly parameters?: Readonly<Record<string, number>>;
  };
  /** The body; the reference one when absent. */
  readonly morphology?: Morphology;
  /** Passive joint resistance; on when absent. */
  readonly passiveJoints?: boolean;
  /** Also pose the skeleton's bones each tick, for a rig that publishes what it does. */
  readonly poseBones?: boolean;
  /** The tremor on the muscles and the grain on the senses; `DEFAULT_NOISE` when not given. */
  readonly noise?: NoiseLevels;
  /** The reflex gains of the cord under the brain; `NO_REFLEX` when not given. */
  readonly reflex?: ReflexLevels;
  /** Context units the policy carries between control steps; none when not given. */
  readonly memory?: number;
}

/** The rig options a recipe asks for. */
export function rigOptionsFor(
  recipe: TrainingRecipe,
  rest: { hidden: readonly number[]; seconds: number; poseBones?: boolean },
): RigOptions {
  return {
    profileId: recipe.profile,
    hidden: rest.hidden,
    seconds: rest.seconds,
    authority: recipe.authority,
    task: recipe.task,
    feedforward: recipe.feedforward,
    ...(recipe.scenario
      ? { scenario: { id: recipe.scenario, parameters: recipe.parameters } }
      : {}),
    morphology: recipe.morphology,
    passiveJoints: recipe.passive,
    noise: recipe.noise ?? DEFAULT_NOISE,
    reflex: recipe.reflex ?? NO_REFLEX,
    memory: recipe.memory ?? 0,
    ...(rest.poseBones ? { poseBones: true } : {}),
  };
}

/**
 * The scenario a run is set in when nothing names one, and the studio's opening scenario:
 * "Drop, standing" at a drop of 0 m, which is the reference body let go standing on the ground.
 * The scenario package's `DEFAULT_SCENARIO` names the same one; this module imports nothing that
 * runs, so it keeps the id itself, and a test holds the two together.
 */
export const DEFAULT_BEHAVIOUR_SCENARIO = 'drop-standing-collapse';
export const DEFAULT_BEHAVIOUR_PARAMETERS: Readonly<Record<string, number>> = { clearance: 0 };

/**
 * Context units the default behaviour carries between control steps.
 *
 * Chosen, not measured. Some, because a policy with none answers only the instant it is shown and
 * cannot integrate a sense that carries grain (`DEFAULT_NOISE.sense`), which is the reason memory
 * was built (ADR-014). Eight, because each unit is a row and a column of weights -- eight add about
 * five hundred to the reference body's network of twenty-seven thousand, two per cent of what the
 * search moves -- and
 * because the studio's Memory slider steps by four, so the form can show the recipe as it is.
 */
export const DEFAULT_BEHAVIOUR_MEMORY = 8;

/**
 * The body and loop of the default behaviour, scored on `task`: the reference body in the default
 * scenario, "Drop, standing" at 0 m, with nothing under the brain, the measured cord, the tremor
 * and the sense grain at their defaults, and `DEFAULT_BEHAVIOUR_MEMORY` context units. What
 * `train:nerves` trains when no recipe is given, what the dashboard fills a request in with, and,
 * for the task `balance` on the reference profile at the default authority, `DEFAULT_BEHAVIOUR`.
 *
 * Nothing under the brain, because the scenario drives no muscles of its own and the owner asked
 * for the falling standing scenario as it is: every unit starts slack and the tone is the policy's
 * and the cord's to find. The cord is `DEFAULT_REFLEX` by name, so a re-measured cord reaches the
 * default behaviour by itself. A task the rig does not score is refused here rather than trained
 * as a stand under another name.
 */
export function behaviourRecipe(task: string, profile: string, authority: number): TrainingRecipe {
  if (!isTask(task)) {
    throw new Error(`unknown task "${task}"; known tasks: ${TASKS.join(', ')}`);
  }
  return {
    name: task,
    task,
    scenario: DEFAULT_BEHAVIOUR_SCENARIO,
    parameters: { ...DEFAULT_BEHAVIOUR_PARAMETERS },
    profile,
    morphology: REFERENCE_MORPHOLOGY,
    passive: true,
    redistribute: true,
    feedforward: { kind: 'none' },
    authority,
    noise: DEFAULT_NOISE,
    reflex: DEFAULT_REFLEX,
    memory: DEFAULT_BEHAVIOUR_MEMORY,
  };
}

/**
 * The one default behaviour, "balance": the recipe the studio's Training tab, the dashboard and
 * `train:nerves` start from when nothing else is chosen, and the one checkpoint the studio ships,
 * `packages/modules-nerves/policies/balance.json`, was trained on (the owner's decision of
 * 2026-09-27, which retired the five checkpoints shipped before it).
 *
 * Every choice in it is a default of this module, with the reasons beside each: the reference
 * profile and body, the default authority, the measured cord, the tremor and the grain, and the
 * search's network, seeds and episode length (`SEARCH_DEFAULTS`). The two that are the behaviour's
 * own are the scenario, which the owner named, and the memory, which the recipes before it did not
 * have (`DEFAULT_BEHAVIOUR_MEMORY` says why eight).
 */
export const DEFAULT_BEHAVIOUR: TrainingRecipe = behaviourRecipe(
  DEFAULT_TASK,
  DEFAULT_PROFILE,
  DEFAULT_AUTHORITY,
);

/**
 * The reference stand: the reference body standing on the ground with the quiet-standing clip
 * under it, and no memory. What the flags described before the default behaviour, kept because
 * the tables in `docs/validation/reflex-gains.md` and the bench's rig rows were measured in it and
 * reproduce only in it. A task the rig does not score is refused here rather than trained as a
 * stand under another name.
 */
export function referenceStandRecipe(
  task: string,
  profile: string,
  authority: number,
): TrainingRecipe {
  if (!isTask(task)) {
    throw new Error(`unknown task "${task}"; known tasks: ${TASKS.join(', ')}`);
  }
  return {
    name: task,
    task,
    scenario: '',
    parameters: {},
    profile,
    morphology: REFERENCE_MORPHOLOGY,
    passive: true,
    redistribute: true,
    feedforward: { kind: 'clip', clip: 'quiet-standing' },
    authority,
    noise: DEFAULT_NOISE,
    reflex: DEFAULT_REFLEX,
    memory: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// The cord from the command line

/** Where the cord a run trains over came from, in the words the trainer's banner prints. */
export type ReflexSource =
  | 'recipe'
  | 'none: the recipe has no cord'
  | "flags over the recipe's cord"
  | 'flags over no cord'
  | 'default, from --reflex default';

/**
 * The cord a run trains over, from its recipe and the `--reflex*` flags.
 *
 * The base is the recipe's cord, or no cord when the recipe has none -- the same reading
 * `rigOptionsFor` gives a recipe, so a flag moves one number of the body the recipe describes and
 * nothing else. It used to fall back on the default cord instead, which meant `--reflex-delay
 * 0.04` on a recipe with no cord switched on a stretch reflex of 3.5 that nobody had asked for.
 * The default cord is still one flag away, as `preset: 'default'`, and no cord as `'none'`.
 */
export function reflexWithFlags(
  recipeReflex: ReflexLevels | undefined,
  flags: Partial<Record<(typeof REFLEX_FIELDS)[number], number>> & {
    preset?: 'default' | 'none';
    regions?: Partial<Record<SpinalRegion, number>>;
  },
): { levels: ReflexLevels; source: ReflexSource } {
  const { preset, regions = {}, ...fields } = flags;
  for (const key of Object.keys(fields)) {
    if (!(REFLEX_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`the cord has no setting called '${key}'`);
    }
  }
  for (const key of Object.keys(regions)) {
    if (!(REFLEX_REGIONS as readonly string[]).includes(key)) {
      throw new Error(`the cord has no region called '${key}'`);
    }
  }
  const given = REFLEX_FIELDS.filter((k) => fields[k] !== undefined);
  for (const k of given) {
    if (!Number.isFinite(fields[k])) {
      throw new Error(`reflex ${k} must be a finite number, not ${String(fields[k])}`);
    }
  }
  const regionsGiven = REFLEX_REGIONS.filter((r) => regions[r] !== undefined);
  for (const r of regionsGiven) {
    if (!Number.isFinite(regions[r])) {
      throw new Error(`reflex stretch for ${r} must be a finite number, not ${String(regions[r])}`);
    }
  }
  const base =
    preset === 'default'
      ? DEFAULT_REFLEX
      : preset === 'none'
        ? NO_REFLEX
        : (recipeReflex ?? NO_REFLEX);
  const { regionStretch: baseRegions, ...levels }: ReflexLevels = { ...base };
  for (const k of given) levels[k] = fields[k] as number;
  // `--reflex` is the stretch everywhere, as the Spine panel's "all regions" slider is, so it
  // clears the base cord's regions; a region flag then sets its own region over it.
  const kept = fields.stretch === undefined ? baseRegions : undefined;
  const merged: Partial<Record<SpinalRegion, number>> = { ...kept };
  for (const r of regionsGiven) merged[r] = regions[r] as number;
  const withRegions: ReflexLevels =
    Object.keys(merged).length > 0 ? { ...levels, regionStretch: merged } : levels;
  const source: ReflexSource =
    preset === 'default'
      ? 'default, from --reflex default'
      : preset === 'none'
        ? 'flags over no cord'
        : given.length === 0 && regionsGiven.length === 0
          ? recipeReflex
            ? 'recipe'
            : 'none: the recipe has no cord'
          : recipeReflex
            ? "flags over the recipe's cord"
            : 'flags over no cord';
  return { levels: withRegions, source };
}

// ---------------------------------------------------------------------------------------------
// Reading and comparing recipes

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What is wrong with a recipe read from a file, one message a problem, or none.
 *
 * Said all at once, because a file with three things wrong that is refused for the first one is
 * refused three times. Old files still pass: the fields added since the first recipe -- noise,
 * the cord, memory, the timescale -- are optional, and only checked for their shape when present.
 */
export function checkRecipe(r: unknown): string[] {
  if (!isObject(r)) return ['a recipe is a JSON object'];
  const problems: string[] = [];
  const need = (field: string, ok: (v: unknown) => boolean, what: string): boolean => {
    if (r[field] === undefined) {
      problems.push(`the recipe has no '${field}'`);
      return false;
    }
    if (!ok(r[field])) {
      problems.push(`the recipe's '${field}' is not ${what}`);
      return false;
    }
    return true;
  };
  const string = (v: unknown) => typeof v === 'string';
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const boolean = (v: unknown) => typeof v === 'boolean';
  const numbers = (v: unknown) => isObject(v) && Object.values(v).every(finite);

  if (need('name', string, 'a string')) {
    const problem = checkpointNameProblem(r.name);
    if (problem) problems.push(problem);
  }
  if (need('task', string, 'a string') && !isTask(r.task)) {
    problems.push(`unknown task "${String(r.task)}"; known tasks: ${TASKS.join(', ')}`);
  }
  need('scenario', string, 'a string');
  need('parameters', numbers, 'an object of numbers');
  need('profile', string, 'a string');
  need(
    'morphology',
    (v) => isObject(v) && finite(v.sex) && finite(v.stature) && finite(v.mass),
    'a body with a sex, a stature and a mass',
  );
  need('passive', boolean, 'true or false');
  need('redistribute', boolean, 'true or false');
  need(
    'feedforward',
    (v) =>
      isObject(v) &&
      (v.kind === 'none' || v.kind === 'script' || (v.kind === 'clip' && string(v.clip))),
    "one of {kind: 'none'}, {kind: 'script'} or {kind: 'clip', clip}",
  );
  need('authority', finite, 'a number');
  const optional = (field: string, ok: (v: unknown) => boolean, what: string) => {
    if (r[field] !== undefined && !ok(r[field]))
      problems.push(`the recipe's '${field}' is not ${what}`);
  };
  optional(
    'noise',
    (v) => isObject(v) && finite(v.motor) && finite(v.sense) && finite(v.tau),
    'a motor, sense and tau',
  );
  optional(
    'reflex',
    (v) =>
      isObject(v) &&
      REFLEX_FIELDS.every((k) => finite(v[k])) &&
      (v.regionStretch === undefined ||
        (isObject(v.regionStretch) &&
          Object.entries(v.regionStretch).every(
            ([k, n]) => (REFLEX_REGIONS as readonly string[]).includes(k) && finite(n),
          ))),
    `the cord's ${REFLEX_FIELDS.length} numbers, and a stretch by region of ${REFLEX_REGIONS.join(', ')} if any`,
  );
  optional('memory', finite, 'a number');
  return problems;
}

/** One way a recipe differs from the one a checkpoint was saved with. */
export interface RecipeChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** The fields of a recipe that make it a different body or a different task, with the value an
 * old file that omits one was trained under; the cord by region when either side's is (see
 * `comparableCord`). */
function comparable(r: TrainingRecipe, byRegion: boolean): Record<string, unknown> {
  return {
    task: r.task,
    scenario: r.scenario,
    parameters: r.parameters,
    profile: r.profile,
    morphology: r.morphology,
    passive: r.passive,
    redistribute: r.redistribute,
    feedforward: r.feedforward,
    authority: r.authority,
    noise: r.noise ?? DEFAULT_NOISE,
    reflex: comparableCord(r.reflex ?? NO_REFLEX, byRegion),
    memory: r.memory ?? 0,
  };
}

/** Every leaf of a value by its dotted path, so a change is named to the number that changed. */
function leaves(prefix: string, value: unknown, out: Map<string, unknown>): void {
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) leaves(prefix ? `${prefix}.${k}` : k, v, out);
  } else {
    out.set(prefix, value);
  }
}

/**
 * How the recipe a run is about to use differs from the one its checkpoint was saved with.
 *
 * A resumed run continues the checkpoint's weights under the recipe it is sent, not the one it was
 * saved with, and that is deliberate -- it is how a policy learnt on a coarse body is carried on
 * to a fine one, or learnt with no cord is taught to use one. But a difference nobody sees is a
 * run trained in a body its person did not mean, so every difference is listed. The name is not
 * compared, because resuming under another name is what a copy is, and neither is the timescale,
 * which the trainer writes from the profile rather than being asked for. A field an old recipe
 * omits compares as the value it was trained under: `DEFAULT_NOISE`, `NO_REFLEX`, no memory.
 */
export function recipeChanges(
  saved: TrainingRecipe | undefined,
  now: TrainingRecipe,
): RecipeChange[] {
  if (!saved) return [];
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  const byRegion = ![saved, now].every((r) => isUniformStretch(r.reflex ?? NO_REFLEX));
  leaves('', comparable(saved, byRegion), before);
  leaves('', comparable(now, byRegion), after);
  const changes: RecipeChange[] = [];
  for (const field of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(field);
    const to = after.get(field);
    if (!Object.is(from, to)) changes.push({ field, from, to });
  }
  return changes;
}

const shown = (v: unknown): string =>
  v === undefined
    ? 'none'
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : JSON.stringify(v);

/**
 * The changes as one line: `reflex.stretch 0 -> 3.5, authority 0.3 -> 0.5`. Empty when there are
 * none, so a caller can say "with changes: ..." only when there is something to say.
 */
export function formatRecipeChanges(changes: readonly RecipeChange[]): string {
  return changes.map((c) => `${c.field} ${shown(c.from)} -> ${shown(c.to)}`).join(', ');
}

/**
 * A recipe in one line, for a status or a list: where the body stands, what plays under the
 * brain, how much say the brain has, the cord, the noise and the memory. Read with the defaults a
 * recipe that omits them was trained under, so an old checkpoint is described as it was.
 */
export function describeRecipe(r: TrainingRecipe): string {
  const where = r.scenario || 'reference stand';
  const under =
    r.feedforward.kind === 'clip'
      ? `the ${r.feedforward.clip} clip under the brain`
      : r.feedforward.kind === 'script'
        ? "the scenario's script under the brain"
        : 'the brain alone';
  const reflex = r.reflex ?? NO_REFLEX;
  const cord = cordIsOff(reflex)
    ? 'no cord'
    : `cord stretch ${describeStretch(reflex)}, damping ${reflex.velocity}, ${Math.round(reflex.delaySeconds * 1000)} ms`;
  const noise = r.noise ?? DEFAULT_NOISE;
  const memory = r.memory ?? 0;
  return [
    where,
    under,
    `authority ${r.authority}`,
    cord,
    `tremor ${noise.motor}, sense ${noise.sense}`,
    memory === 0 ? 'no memory' : `memory ${memory}`,
  ].join('; ');
}
