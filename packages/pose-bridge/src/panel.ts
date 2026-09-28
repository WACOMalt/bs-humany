/**
 * The panel's two files beside the rings: the status a publisher writes and the commands a viewer
 * appends.
 *
 * `<path>-status.json` is one JSON object, renamed into place by whoever publishes -- the studio,
 * `pnpm publish:pose`, the training showcase -- a few times a second. `<path>-commands.jsonl` is
 * one JSON object a line, appended by the viewer when its panel is pressed and read by the
 * publisher from wherever it last stopped. The reader of the one and the writer of the other is
 * `apps/xr-viewer/src/bridge.rs` and `panel.rs`.
 *
 * The shapes are stated here, once, because they used to be stated three times -- an interface in
 * the studio, and an object literal in each of the two scripts -- and a field added to one of them
 * reached the headset from that publisher only, or was renamed in one and silently read as its
 * default by the Rust side. Now every publisher builds a `PanelStatus`, so tsc refuses a key
 * that is missing or misspelt, and `pnpm generate:pose-bridge-fixture` writes a sample of it
 * with every field filled to `apps/xr-viewer/fixtures/status.json`, which the Rust side's test
 * parses and pins. A field that moves on either side fails one of the two.
 *
 * Like the rest of `codec.ts`, which re-exports this, it touches no file system: the studio
 * builds its status in a browser.
 *
 * Which keys are optional follows who can say them. What every publisher knows -- which run,
 * which scenario, how far along, what is held -- is required, and is what the Rust side needs to
 * read a status at all. What only some publishers have -- the studio's overlays and brain panel,
 * the showcase's training run, a scenario's own parameters -- is optional here and defaults to
 * empty or off on the Rust side, so an older publisher is still a publisher.
 */

/** The suffix of the status file, after the pose ring's path. */
export const STATUS_SUFFIX = '-status.json';
/** The suffix of the panel's command log, after the pose ring's path. */
export const COMMANDS_SUFFIX = '-commands.jsonl';

/** The mode the studio's top bar shows: at rest, running, paused, or following the bridge. */
export type PanelMode = 'rest' | 'running' | 'paused' | 'following';

/** A scenario as the picker lists it. */
export interface PanelScenario {
  readonly id: string;
  readonly title: string;
  /** What the scenario is and what to watch for, as the desktop's note under the picker says. */
  readonly description?: string;
}

/**
 * A fidelity profile as the Body row lists it: the id a `set profile` command sends, and the name
 * the desktop's picker shows. The headset used to be sent the ids alone and drew `l3_anatomical`
 * where the desktop says "L3 — Anatomical".
 */
export interface PanelProfile {
  readonly id: string;
  readonly title: string;
}

/**
 * A slider's reach and step, as the headset draws it: `CONTROL_RANGES` in
 * packages/scenarios/src/controls.ts, the one table both panels take theirs from.
 */
export interface PanelControl {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** One of the chosen scenario's own parameters, as its slider shows it. */
export interface PanelScenarioParameter {
  readonly id: string;
  readonly title: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The unit, for the label: `m`, `s`, or empty. */
  readonly unit: string;
}

/**
 * Everything the panel's sliders and boxes set, as the publisher has it now. Every key is
 * optional: a publisher offers the ones it can change, and the showcase, which changes none of
 * them, sends none.
 */
export interface PanelSettings {
  readonly muscles?: boolean;
  /** Skeletal proportions, 0 female to 1 male. */
  readonly sex?: number;
  /** Metres. */
  readonly stature?: number;
  /** Kilograms. */
  readonly mass?: number;
  readonly crural?: number;
  readonly brachial?: number;
  readonly legLength?: number;
  /** The ANSUR II percentile that sets stature and mass together. */
  readonly percentile?: number;
  /**
   * Metres, for a free drop only: a scenario places the body itself. `pnpm publish:pose` always
   * runs a scenario and so leaves it out, and the headset then shows no drop height at all rather
   * than a slider that reads zero and moves nothing.
   */
  readonly dropHeight?: number;
  readonly passive?: boolean;
  readonly redistribute?: boolean;
  readonly gravity?: boolean;
  readonly floor?: boolean;
  /** Poses published a second. */
  readonly fps?: number;
  readonly stepsPerSecond?: number;
}

/** A muscle group's drive slider. */
export interface PanelDriveGroup {
  readonly title: string;
  /** The slider, 0 to 100. */
  readonly level: number;
  /** Arm, Hand, Leg, Trunk or Neck: the section the desktop folds the slider under. */
  readonly section?: string;
}

/** A box in the scenery, in the simulation's frame: half extents, centre, rotation xyzw. */
export interface PanelStaticBox {
  readonly halfExtents: readonly number[];
  readonly position: readonly number[];
  readonly rotation: readonly number[];
}

/**
 * The studio's diagnostics strip, as numbers. Optional one by one, because a publisher with no
 * run -- the studio at rest -- sends it empty.
 */
export interface PanelDiagnostics {
  /** Joules. */
  readonly kinetic?: number;
  /** Joules. */
  readonly potential?: number;
  /** The joints' drift apart, in millimetres. */
  readonly driftMm?: number;
  /** The nearest joint stop, as a fraction of the range; 1 is at the stop. */
  readonly limitsWorst?: number;
  /** Joints past a stop. */
  readonly violations?: number;
  readonly contacts?: number;
  /** Milliseconds a tick. */
  readonly costMs?: number;
}

/** The connective tissue, in bone frames, so the headset can draw it from the poses. */
export interface PanelTissue {
  readonly discs: readonly {
    readonly bone: string;
    readonly kind: 'disc' | 'bead';
    readonly position: readonly number[];
    readonly rotation: readonly number[];
  }[];
  readonly bars: readonly {
    readonly boneA: string;
    readonly localA: readonly number[];
    readonly boneB: string;
    readonly localB: readonly number[];
  }[];
}

/** The spinal cord's gains, as the desktop's Spine panel has them. */
export interface PanelReflex {
  /** The stretch gain for all regions: what a region takes while it follows. */
  readonly stretch: number;
  readonly velocity: number;
  readonly setPoint: number;
  readonly inhibition: number;
  readonly delaySeconds: number;
  /**
   * The stretch of each region with one of its own, by the region's name (`Arm`, `Hand`, `Leg`,
   * `Trunk`, `Neck`); a region not named follows `stretch`. Absent from a publisher that has no
   * regions, which reads as every region following.
   */
  readonly regionStretch?: Readonly<Record<string, number>> | undefined;
}

/**
 * The Brain tab as the desktop has it. The studio's own `BrainState` is this shape, and is held
 * to it key for key (see `apps/studio/src/vrLink.ts`), so the headset draws the desktop's button
 * rules and notes rather than a copy of them.
 */
export interface PanelBrain {
  readonly serverUp: boolean;
  readonly active: boolean;
  readonly authority: number;
  readonly selected: string;
  readonly checkpoints: readonly { readonly id: string; readonly name: string }[];
  readonly fit: string;
  readonly training: string;
  readonly trainingRunning: boolean;
  /** Whether Stop would do anything: the trainer, or the showcase that outlives it. */
  readonly trainingStoppable: boolean;
  readonly following: boolean;
  readonly reflex: PanelReflex;
  /** Context units the next run will train with. */
  readonly memory: number;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canHandOver: boolean;
  readonly canRelease: boolean;
  /** Set up as trained: the tabs as the chosen checkpoint was trained, Authority included. */
  readonly canSetUp: boolean;
  /** Undo of the last set-up. */
  readonly canUndoSetUp: boolean;
  /**
   * The line under the checkpoint list: where the list comes from, or how the chosen checkpoint
   * was trained and how that differs from the tabs. Choosing one only shows it.
   */
  readonly policyNote: string;
  /** What the Spine panel says of the cord as it is set. */
  readonly spineNote: string;
}

/** What the training showcase says of the run it is playing. */
export interface PanelTraining {
  readonly task: string;
  readonly episode: number;
  readonly generation: number;
  readonly fitness: number;
}

/** The whole status file, as every publisher writes it. */
export interface PanelStatus {
  /**
   * Unique per publisher run -- each starts it at its start time in milliseconds -- and bumped on
   * every rebuild of its bridge files. A viewer that sees it change reopens them.
   */
  readonly generation: number;
  readonly scenario: PanelScenario;
  readonly scenarios: readonly PanelScenario[];
  readonly profiles: readonly PanelProfile[];
  /** The id of the profile the run is built on. */
  readonly profile: string;
  /** The run time of the frame on screen, in simulated seconds. */
  readonly simSeconds: number;
  readonly wallSeconds: number;
  /** Simulated seconds a wall second: 1 is life speed, 0 paused. */
  readonly speed: number;
  readonly paused: boolean;
  /** Whether the muscle ring beside the pose ring is being written. */
  readonly muscles: boolean;
  /** The bones the headset's hands hold, by name. */
  readonly holding: readonly string[];
  readonly grabStrength: number;
  readonly stepsPerSecond: number;
  readonly fps: number;
  readonly settings: PanelSettings;
  readonly driveGroups: readonly PanelDriveGroup[];
  readonly diagnostics: PanelDiagnostics;
  readonly groundHeight: number;
  readonly staticBoxes: readonly PanelStaticBox[];
  /** Tendon force as a fraction of each unit's maximum, in the muscle ring's unit order. */
  readonly tension: readonly number[];
  readonly tissue: PanelTissue;
  readonly mode?: PanelMode;
  /** The viewport's overlays by checkbox id without the `show` prefix. */
  readonly overlays?: Readonly<Record<string, boolean>>;
  readonly scenarioParameters?: readonly PanelScenarioParameter[];
  /**
   * The Muscles tab's readout, as text by key: `section.arm`, `section.hand`, `section.leg`,
   * `section.trunk` and `section.neck` (tendon force summed over each body section's drive
   * groups), then `loaded`, `wrapping` and `strained`.
   */
  readonly muscleReadout?: Readonly<Record<string, string>>;
  /**
   * The reach and step of each slider this publisher honours, by the key its `set` is sent with
   * (`stature`, `spine.delay`, ...). The headset draws a slider only for a key named here, so a
   * publisher that changes none of them -- the showcase -- sends none and offers none.
   */
  readonly controls?: Readonly<Record<string, PanelControl>>;
  readonly brain?: PanelBrain;
  readonly training?: PanelTraining;
  /** How far the recording reaches, in the same seconds as `simSeconds`. */
  readonly recordedSeconds?: number;
  /** Whether the desktop is playing a recording back. */
  readonly playing?: boolean;
  /** Whether the desktop is on the live edge rather than scrubbed back. */
  readonly live?: boolean;
}

/** The headset's hands on the Brain tab: every button and slider it can press or move. */
export type PanelBrainAction =
  /** Choose a checkpoint in the list, which only shows it. */
  | 'select'
  /** Set the tabs up as the chosen checkpoint was trained. */
  | 'setup'
  /** Put back what the last set-up changed. */
  | 'undoSetup'
  | 'handover'
  | 'release'
  | 'authority'
  | 'trainStart'
  | 'trainStop'
  | 'follow'
  | 'reflexStretch'
  /** One region's stretch: `id` names the region, `value` is its stretch. */
  | 'reflexRegionStretch'
  | 'reflexVelocity'
  | 'reflexSetPoint'
  | 'reflexInhibition'
  | 'reflexDelay'
  | 'memory';

/** One line of the command log: what the panel asks the publisher for. */
export type PanelCommand =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'reset' }
  /** One output frame forward (positive) or back. */
  | { readonly kind: 'step'; readonly frames: number }
  /** To this many simulated seconds. */
  | { readonly kind: 'scrub'; readonly seconds: number }
  /** A muscle group's slider, 0 to 100, by its index in `driveGroups`. */
  | { readonly kind: 'drive'; readonly group: number; readonly value: number }
  /**
   * A setting by its `PanelSettings` name, or `grabStrength`, `scenario`, `profile`; an
   * `overlay.<name>`; or `scenario.<id>`, one of the chosen scenario's own parameters. The
   * publisher decides whether it rebuilds.
   */
  | { readonly kind: 'set'; readonly key: string; readonly value: unknown }
  | {
      readonly kind: 'brain';
      readonly action: PanelBrainAction;
      readonly id?: string;
      readonly value?: number;
    };

/** Anything with x, y, z: a `Vec3` of the frames package, without depending on it. */
interface Xyz {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A static box as the status carries it: arrays rather than the simulation's objects, and the
 * identity when the box has no rotation.
 */
export function staticBoxJson(box: {
  readonly halfExtents: Xyz;
  readonly position: Xyz;
  readonly rotation?: (Xyz & { readonly w: number }) | undefined;
}): PanelStaticBox {
  const { halfExtents: h, position: p, rotation: r } = box;
  return {
    halfExtents: [h.x, h.y, h.z],
    position: [p.x, p.y, p.z],
    rotation: r ? [r.x, r.y, r.z, r.w] : [0, 0, 0, 1],
  };
}
