/**
 * `@bs-humany/scenarios` -- the committed scenario set of spec section 13.5.
 *
 * A scenario is declarative: which profile and morphology, how the body starts, what is in the
 * world, how long to run, and what a scripted hand does at each tick. Nothing in it names a
 * backend, which is what makes the goldens (13.2) mean something, and what made the conformance
 * harness (13.3) possible while there were two backends to compare. Scripted actions are
 * functions rather than data because a grab that follows a circle is simplest written as one
 * line of arithmetic; nothing in a script reaches a backend directly, only the API the runner
 * hands it.
 */

import type { StaticBox } from '@bs-humany/compiler';
import { type Quat, type Vec3, fromAxisAngle, vec3 } from '@bs-humany/frames';
import type { Morphology } from '@bs-humany/hsdl';
import { REFERENCE_MORPHOLOGY } from '@bs-humany/skeleton';

/** What a script may do each tick. */
export interface ScenarioApi {
  /** Segment index by id, or -1. */
  segment(id: string): number;
  /** World position of a segment's origin, from the last solve. */
  segmentPosition(index: number): Vec3;
  grab(segmentIndex: number, localPoint: Vec3, worldTarget: Vec3): void;
  moveGrab(worldTarget: Vec3): void;
  release(): void;
  // No `drive`. A script once drove muscle units too, and seven scenarios were built on it -- the
  // ankle strategy, the range of motion, the flailing arms, the activation clips played open loop,
  // the trained policy over the standing clip. The owner deleted all seven on 2026-09-28: the
  // muscles belong to the drive sliders, the cord belongs to the Spine sliders and a brain belongs
  // to the Brain tab, so a scenario says where the body is and what the world does to it, and
  // nothing about what its nerves ask for. A scenario may still ask for the muscle set to be
  // there (`Scenario.muscles`), which is how the tilting floor gives a brain something to drive.
  /**
   * Put one of the scenery's boxes somewhere, by the id it was declared with.
   *
   * For a platform that tilts under the body. The box is scenery: it has no velocity of its own
   * and carries nothing along by friction, but its surface is where it is put and the normal the
   * body stands on turns with it. A run without the means to move one ignores this.
   */
  moveStaticBox(id: string, position: Vec3, rotation: Quat): void;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly profileId: string;
  readonly morphology: Morphology;
  readonly durationSeconds: number;
  /**
   * Run the muscle set, so the drive sliders, the cord and a brain have something to drive.
   *
   * Off by default: most scenarios are about the skeleton, and every unit costs a solve per tick.
   * On forces the muscles on whatever the studio's Muscles box says, which is all a scenario may
   * say about them: nothing here drives one.
   */
  readonly muscles?: boolean | undefined;
  /** Rotation applied to the whole rest pose about the root, before lifting. */
  readonly rootRotation?: Quat | undefined;
  /** Height of the lowest segment origin above the ground after placement. */
  readonly clearance: number;
  readonly ground: { readonly height: number };
  readonly staticBoxes?: readonly StaticBox[] | undefined;
  readonly passiveJoints: boolean;
  /** Runs every tick with the simulation time in seconds. */
  readonly script?: ((time: number, api: ScenarioApi) => void) | undefined;
  /** Whether a passive-system energy check applies: false when a script pumps energy in. */
  readonly passiveSystem: boolean;
  /**
   * The run is expected to be at rest at its end; false for a scenario whose drive or shake never
   * stops. Defaults to true. A scenario that is still moving by design says so here, with its
   * reason beside the flag, rather than by raising the kinetic energy that counts as at rest: a
   * raised threshold would still pass a run that ended in a runaway, where a flag switches the
   * one check off and leaves the peak-energy bound watching the whole run.
   */
  readonly settles?: boolean | undefined;
  /**
   * Per-scenario tolerance overrides (spec 13.3: tolerances are per scenario). Each applies over
   * the MuJoCo defaults in the testkit's `plausibility.ts`, which live with the checks and say
   * why they are what they are, and each carries its own reason where it is set.
   */
  readonly plausibility?: Readonly<Partial<Record<PlausibilityKey, number>>> | undefined;
  /**
   * Whether a golden trajectory is kept for this scenario. Off for one built for a brain to be
   * trained on -- the tilting floor -- whose run is whatever policy is handed over on it, so its
   * hash would be a record of the last policy rather than of the physics.
   */
  readonly golden?: boolean | undefined;
}

export type PlausibilityKey =
  | 'energyRisePerSample'
  | 'rangeViolation'
  | 'penetration'
  | 'restKinetic'
  | 'peakKinetic'
  | 'drift'
  | 'ballistic';

const REFERENCE = REFERENCE_MORPHOLOGY;
const SUPINE = fromAxisAngle(vec3(1, 0, 0), Math.PI / 2);
const PRONE = fromAxisAngle(vec3(1, 0, 0), -Math.PI / 2);

function stairs(steps: number, rise: number, run: number, width: number): StaticBox[] {
  // The body faces anterior, which is -Z (ADR-010), so the steps descend toward -Z. The top step
  // sits under the feet, and a landing behind it stops anything falling off the back.
  const out: StaticBox[] = [];
  const top = rise * steps;
  out.push({
    id: 'stair_landing',
    halfExtents: vec3(width / 2, top / 2, 0.6),
    position: vec3(0, top / 2, run / 2 + 0.6),
  });
  for (let i = 0; i < steps; i++) {
    const height = rise * (steps - i);
    out.push({
      id: `stair_${i}`,
      halfExtents: vec3(width / 2, height / 2, run / 2),
      position: vec3(0, height / 2, -run * i),
    });
  }
  return out;
}

/**
 * A number the studio lets you turn before a run.
 *
 * A scenario without these is a fixed experiment, which is what the goldens need; with them it
 * is also something to play with, which is what the studio needs. The defaults reproduce the
 * fixed experiment exactly, so the two never drift apart.
 */
export interface ScenarioParameter {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The value the committed scenario uses. */
  readonly value: number;
  /** Suffix for the readout: ` m`, ` rad`, or empty. */
  readonly unit: string;
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly parameters: readonly ScenarioParameter[];
  /** Build the scenario at these parameter values; missing ones fall back to the defaults. */
  build(values?: Readonly<Record<string, number>>): Scenario;
}

const param = (
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit = ' m',
): ScenarioParameter => ({ id, label, min, max, step, value, unit });

/** Parameter values with every default filled in. */
function withDefaults(
  parameters: readonly ScenarioParameter[],
  values: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of parameters) {
    const given = values[p.id];
    out[p.id] = given === undefined || !Number.isFinite(given) ? p.value : given;
  }
  return out;
}

export {
  ANTAGONISTS,
  MUSCLE_GROUPS,
  applyDriveSliders,
  driveForSlider,
  reflexGroups,
  type DriveGroup,
  type DriveSection,
} from './muscleGroups.js';
export {
  ACTIVATION_CLIP_FILE,
  type ActivationClip,
  type ClipFile,
  type ClipTrack,
  CompiledClip,
  compileClip,
  loadActivationClips,
  unitsNamedByClips,
} from './activationClips.js';
import { PLATFORM_TOP, platformBox, tiltingFloor } from './tiltingFloor.js';
export {
  GOAL_SIZE,
  GOALS,
  controlDivisorFor,
  driveOutputs,
  type NervesSetup,
} from './nerves.js';
export { defaultControlDivisor, profileRateHz } from './solverRate.js';
export {
  CONTROL_RANGES,
  type ControlKey,
  type ControlRange,
  isControlKey,
  snapToControl,
} from './controls.js';

function define(
  definition: Omit<ScenarioDefinition, 'build'> & {
    make(values: Record<string, number>): Omit<Scenario, 'id' | 'title' | 'description'>;
  },
): ScenarioDefinition {
  const { make, ...rest } = definition;
  return {
    ...rest,
    build(values) {
      return {
        id: rest.id,
        title: rest.title,
        description: rest.description,
        ...make(withDefaults(rest.parameters, values)),
      };
    },
  };
}

export const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  define({
    id: 'tilting-floor',
    title: 'Tilting floor',
    description:
      'The rest pose on a floor that pitches and rolls under it in small random pulses -- a few ' +
      'degrees, a fraction of a second each, a direction and a size drawn afresh every pulse ' +
      'from the seed. Nothing drives the muscles: this is a floor for a brain to be trained on, ' +
      'where a posture held still goes over at the first pulse and only a body that feels the ' +
      'tilt and answers it stays up. What turns is a low platform the body stands on, about the ' +
      'middle of its own top face so the face stays put and only its angle changes; the floor is ' +
      'below it, for a body that comes off.',
    parameters: [
      param('tilt', 'Tilt, at most', 4, 0, 15, 0.5, '\u00b0'),
      param('every', 'A pulse every', 0.8, 0.2, 3, 0.1, ' s'),
      param('hold', 'Held for', 0.3, 0.05, 2, 0.05, ' s'),
      param('seed', 'Seed', 1, 1, 9999, 1, ''),
    ],
    make: (v) => ({
      profileId: 'l3_anatomical',
      morphology: REFERENCE,
      muscles: true,
      durationSeconds: 6,
      // On the platform's top face, with the floor below it.
      clearance: PLATFORM_TOP,
      ground: { height: 0 },
      staticBoxes: [platformBox()],
      passiveJoints: true,
      // The platform pumps energy in, and the run changes with the policy on it: no golden.
      passiveSystem: false,
      golden: false,
      script: tiltingFloor({
        tilt: v.tilt as number,
        every: v.every as number,
        hold: v.hold as number,
        seed: v.seed as number,
      }),
    }),
  }),
  define({
    id: 'drop-standing-collapse',
    title: 'Drop, standing',
    description:
      'The rest pose let go standing on the ground, or dropped onto it from the drop height. With ' +
      'nothing holding it up it buckles and settles; it is the scenario the shipped balance ' +
      'behaviour is trained in, and the one the studio opens on.',
    // 0 m since 2026-09-27, the owner's choice: the body let go standing, the scenario the default
    // behaviour trains in. It was 0.3 m, a drop onto both feet, which is still a slider away.
    parameters: [param('clearance', 'Drop height', 0, 0, 1.5, 0.05)],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 3,
      clearance: v.clearance as number,
      ground: { height: 0 },
      passiveJoints: true,
      passiveSystem: true,
      // Landing upright on two feet from a drop is the hardest impact of any scenario: from the
      // 0.3 m this defaulted to until 2026-09-27, 230 J leaves the ledger in a single 20 ms
      // sample, the contact compresses about a centimetre, and the sample after it the contact
      // spring returns a few joules of that as it pushes the body back out. The rise is 2% of
      // the impact, it happens once, and the body settles immediately afterwards, so it is a
      // soft contact behaving as designed rather than the runaway this check exists to catch.
      // Kept for the drop height's slider, whatever the default.
      plausibility: { energyRisePerSample: 8 },
    }),
  }),
  define({
    id: 'drop-supine',
    title: 'Drop, supine',
    description: 'Lying face up, released above the ground. It should land flat and stay.',
    parameters: [param('clearance', 'Drop height', 0.5, 0, 1.5, 0.05)],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 3,
      rootRotation: SUPINE,
      clearance: v.clearance as number,
      ground: { height: 0 },
      passiveJoints: true,
      passiveSystem: true,
    }),
  }),
  define({
    id: 'drop-prone',
    title: 'Drop, prone',
    description: 'Lying face down, released above the ground.',
    parameters: [param('clearance', 'Drop height', 0.5, 0, 1.5, 0.05)],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 3,
      rootRotation: PRONE,
      clearance: v.clearance as number,
      ground: { height: 0 },
      passiveJoints: true,
      passiveSystem: true,
    }),
  }),
  define({
    id: 'stairs-tumble',
    title: 'Stairs tumble',
    description: 'Released standing at the top of a flight, leaning forward so it goes down them.',
    parameters: [
      param('steps', 'Steps', 6, 2, 12, 1, ''),
      param('rise', 'Step rise', 0.17, 0.08, 0.3, 0.01),
      param('run', 'Step run', 0.28, 0.15, 0.5, 0.01),
      param('lean', 'Forward lean', 0.35, 0, 1, 0.05, ' rad'),
      param('clearance', 'Drop above the top step', 0.08, 0, 0.6, 0.02),
    ],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 4,
      rootRotation: fromAxisAngle(vec3(1, 0, 0), -(v.lean as number)),
      // Above the top step, not above the ground: a taller flight would otherwise drop the body
      // from the same height onto a step that has risen to meet it.
      clearance: (v.rise as number) * (v.steps as number) + (v.clearance as number),
      ground: { height: 0 },
      staticBoxes: stairs(v.steps as number, v.rise as number, v.run as number, 2),
      passiveJoints: true,
      passiveSystem: true,
      // The same landing drop-standing-collapse makes, from lower and onto a step: the body lands
      // on its feet at about 0.2 s and the contact returns a little of the impact as it pushes the
      // body back out. It was 1.0 J over a sample until the malleoli, and with them the ankle's
      // centre, went back to where their own rules put them on 2026-09-27 (OQ-032); it is 2.2 J
      // since, once, with the body settling afterwards and 454 J in play at the flight's peak.
      plausibility: { energyRisePerSample: 3 },
    }),
  }),
  define({
    id: 'hang-from-wrist',
    title: 'Hang from a wrist',
    description: 'The right hand is held up for the whole run; the body hangs and settles.',
    parameters: [
      param('hold', 'Hand height', 2.1, 1.2, 2.6, 0.05),
      param('clearance', 'Start height', 0.2, 0, 1, 0.05),
    ],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 6,
      clearance: v.clearance as number,
      ground: { height: 0 },
      passiveJoints: true,
      passiveSystem: false,
      script: (time, api) => {
        const hand = api.segment('hand_r');
        if (time === 0) api.grab(hand, vec3(0, 0, 0), vec3(0.2, v.hold as number, 0));
      },
    }),
  }),
  define({
    id: 'skull-wiggle',
    title: 'Shake the skull',
    description:
      'The head is held and shaken at a chosen frequency. At 500 Hz on the 1000 Hz profile that ' +
      'is exactly two ticks a cycle -- the fastest signal a fixed step of that size can carry -- ' +
      'so stepping through it should show the target alternating either side of centre on ' +
      'successive ticks, and never two the same way.',
    parameters: [
      param('frequency', 'Shake frequency', 500, 1, 500, 1, ' Hz'),
      param('amplitude', 'Amplitude', 0.03, 0.002, 0.15, 0.002, ' m'),
      param('clearance', 'Start height', 0.02, 0, 1, 0.02),
    ],
    make: (v) => {
      // Captured at time zero: where the head was before anything shook it. Held in the closure
      // rather than recomputed, so the shake is about a fixed point and not about wherever the
      // head has drifted to.
      //
      // Captured again, with the grab, every time the script is at time zero, not only the first
      // time the closure runs. A run that starts over from the top reuses the closure it had: the
      // studio's Reset restores the body to tick zero and releases the grab, and so does the
      // headset's. Keyed on the closure alone, the replay found a centre already set, never
      // grabbed, and moved a grab that held nothing while the head fell. Time zero is the one
      // tick every run passes through, and the first run through it does exactly what it did
      // before, so the goldens stand.
      let centre: Vec3 | undefined;
      return {
        profileId: 'l3_anatomical',
        morphology: REFERENCE,
        durationSeconds: 4,
        clearance: v.clearance as number,
        ground: { height: 0 },
        passiveJoints: true,
        // A script driving a joint at half the tick rate is pumping energy in by the bucket.
        passiveSystem: false,
        // It is still being shaken when the run ends, so of course it is still moving: a head
        // vibrating a couple of millimetres, which is the scenario doing exactly what it was
        // written to do. It happens to end under a joule (0.51 J), but that is the amplitude
        // talking, not rest.
        settles: false,
        script: (time, api) => {
          const head = api.segment('head');
          if (head < 0) return;
          if (time === 0 || centre === undefined) {
            centre = api.segmentPosition(head);
            api.grab(head, vec3(0, 0, 0), centre);
          }
          // Cosine, so that at half the tick rate the samples land on the peaks rather than on
          // the zero crossings. `sin(2 pi * 500 * t/1000)` is `sin(pi t)`, which is zero at every
          // whole tick -- a perfectly sampled signal that never moves anything.
          const swing =
            (v.amplitude as number) * Math.cos(2 * Math.PI * (v.frequency as number) * time);
          api.moveGrab(vec3(centre.x + swing, centre.y, centre.z));
        },
      };
    },
  }),
  define({
    id: 'seated-on-box',
    title: 'Onto a box',
    description:
      'Released standing beside a box so the collapse lands the pelvis on it. Not a seated ' +
      'pose: joints cannot be posed directly in reduced coordinates, so the seat is earned.',
    parameters: [
      param('seatHeight', 'Seat height', 0.44, 0.15, 0.8, 0.02),
      param('seatDistance', 'Seat distance behind', 0.35, 0, 0.8, 0.05),
      param('lean', 'Backward lean', 0.25, 0, 1, 0.05, ' rad'),
      param('clearance', 'Drop height', 0.25, 0, 1.5, 0.05),
    ],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 3,
      rootRotation: fromAxisAngle(vec3(1, 0, 0), v.lean as number),
      clearance: v.clearance as number,
      ground: { height: 0 },
      staticBoxes: [
        {
          id: 'seat',
          halfExtents: vec3(0.3, (v.seatHeight as number) / 2, 0.25),
          position: vec3(0, (v.seatHeight as number) / 2, v.seatDistance as number),
        },
      ],
      passiveJoints: true,
      passiveSystem: true,
    }),
  }),
  define({
    id: 'grab-and-swing',
    title: 'Grab and swing',
    description: 'The right hand is grabbed, swung in a horizontal circle, and released.',
    parameters: [
      param('radius', 'Swing radius', 0.6, 0.2, 1.2, 0.05),
      param('height', 'Swing height', 1.5, 0.8, 2.4, 0.05),
      param('swingSeconds', 'Seconds before release', 2, 0.5, 3.5, 0.25, ' s'),
      param('clearance', 'Start height', 0.2, 0, 1, 0.05),
    ],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 4,
      clearance: v.clearance as number,
      ground: { height: 0 },
      passiveJoints: true,
      passiveSystem: false,
      script: (time, api) => {
        const hand = api.segment('hand_r');
        const radius = v.radius as number;
        const height = v.height as number;
        const until = v.swingSeconds as number;
        if (time === 0) api.grab(hand, vec3(0, 0, 0), vec3(radius, height, 0));
        else if (time < until)
          api.moveGrab(
            vec3(radius * Math.cos(time * Math.PI), height, radius * Math.sin(time * Math.PI)),
          );
        else if (time < until + 0.01) api.release();
      },
    }),
  }),
];

/**
 * The one a tool should open on, unless it has a reason not to.
 *
 * Named here rather than "the first definition", so that adding a scenario at the top of the list
 * does not silently change what every consumer opens with.
 *
 * "Drop, standing", at its default drop of 0 m, since the owner's decision of 2026-09-27: it is the
 * scenario the one shipped behaviour, balance, is trained in, so the studio opens on the body that
 * behaviour was brought up in. It was `quiet-standing`, the posture a muscle module's front page
 * first showed, which was deleted on 2026-09-28 (`RETIRED_SCENARIOS`). The training recipe module
 * keeps the same id as `DEFAULT_BEHAVIOUR_SCENARIO`, and a test there holds the two together.
 */
export const DEFAULT_SCENARIO = 'drop-standing-collapse';

/**
 * The scenarios the owner deleted on 2026-09-28, by the ids old files still carry.
 *
 * Every one of them drove muscles from its script -- the ankle strategy of "Standing quietly", the
 * range of motion muscle by muscle, the flailing elbows, the three activation clips played open
 * loop, and "Standing, with the nerves", the shipped policy over the standing clip -- and a
 * scenario no longer does that: the drive sliders own the muscles, the Spine sliders own the cord
 * and the Brain tab owns a brain. The tilting floor, which forces the muscles on and drives none,
 * stayed. The activation clips themselves stayed too, because a brain can still be trained over
 * one (`{kind: 'clip'}` in a recipe), and one of them is called `quiet-standing` like the deleted
 * scenario: a clip id is not a scenario id, and nothing here touches the clips.
 *
 * Kept as a list, not forgotten, because the files that name them outlive the code: a saved
 * session, a training recipe, a checkpoint's own recipe. Each of those still loads, in the default
 * scenario, and says once that it did (`replacementFor`). The training recipe module keeps its own
 * copy of this list, for the reason it keeps its own copy of `DEFAULT_SCENARIO`, and a test holds
 * the two together.
 */
export const RETIRED_SCENARIOS: readonly string[] = [
  'quiet-standing',
  'muscle-range-of-motion',
  'arm-flail',
  'clip-quiet-standing',
  'clip-walk-normal',
  'clip-flail-arms',
  'nerves-stand',
];

/**
 * What stands in for a scenario an old file names: `DEFAULT_SCENARIO` at its defaults for one of
 * the `RETIRED_SCENARIOS`, with the sentence to say about it once; undefined for any other id,
 * which is either a scenario that exists or one this studio never had and should be refused as
 * one.
 */
export function replacementFor(
  id: string,
): { readonly id: string; readonly note: string } | undefined {
  if (!RETIRED_SCENARIOS.includes(id)) return undefined;
  return { id: DEFAULT_SCENARIO, note: retiredScenarioNote(id) };
}

/**
 * The sentence every tool says when an old file names a deleted scenario, so the studio's event
 * line and a command line word it the same way.
 */
export function retiredScenarioNote(id: string): string {
  return (
    `the scenario ${id} was deleted on 2026-09-28 (scenarios no longer drive muscles), so ` +
    '"Drop, standing" at 0 m is used in its place'
  );
}

/**
 * The committed scenario set: every definition at its default parameters (spec 13.5).
 *
 * Shared instances for listing only; call `scenario(id)` or `definition.build()` for a run. A
 * script is a closure and may keep state in it -- the shaken head's centre -- so two runs through
 * one instance are not two runs of the scenario: the second starts from wherever the first left
 * that state. The goldens run these, each once.
 */
export const SCENARIOS: readonly Scenario[] = SCENARIO_DEFINITIONS.map((d) => d.build());

/**
 * One run's worth of a scenario at its defaults, built afresh on every call.
 *
 * Fresh rather than looked up in `SCENARIOS`, so a caller that builds a second run -- publish-pose
 * rebuilding when the frame rate or the profile changes, a headset reset -- gets a script with no
 * history, not the closure the last run went through.
 */
export function scenario(id: string): Scenario {
  const definition = SCENARIO_DEFINITIONS.find((d) => d.id === id);
  if (!definition) {
    throw new Error(
      `No scenario '${id}'. Known: ${SCENARIO_DEFINITIONS.map((d) => d.id).join(', ')}.`,
    );
  }
  return definition.build();
}

export * from './place.js';
export * from './reports.js';
export * from './scenarioApi.js';
export * from './tiltingFloor.js';
