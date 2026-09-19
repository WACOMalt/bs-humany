/**
 * `@bs-humany/scenarios` -- the committed scenario set of spec section 13.5.
 *
 * A scenario is declarative: which profile and morphology, how the body starts, what is in the
 * world, how long to run, and what a scripted hand does at each tick. The same scenario runs on
 * every backend, which is what makes the conformance harness (13.3) and the goldens (13.2) mean
 * something. Scripted actions are functions rather than data because a grab that follows a
 * circle is simplest written as one line of arithmetic; nothing in a script reaches a backend
 * directly, only the API the runner hands it.
 */

import type { StaticBox } from '@bs-humany/compiler';
import { type Quat, type Vec3, fromAxisAngle, vec3 } from '@bs-humany/frames';
import type { Morphology } from '@bs-humany/hsdl';

/** What a script may do each tick. */
export interface ScenarioApi {
  /** Segment index by id, or -1. */
  segment(id: string): number;
  /** World position of a segment's origin, from the last solve. */
  segmentPosition(index: number): Vec3;
  grab(segmentIndex: number, localPoint: Vec3, worldTarget: Vec3): void;
  moveGrab(worldTarget: Vec3): void;
  release(): void;
  /**
   * Drive one muscle unit, 0 to 1, until told otherwise.
   *
   * Excitation rather than force: what a script asks for is what a nerve would ask for, and what
   * the muscle does with it is the muscle's business -- activation lags it, the fiber has to be
   * at a length where it can pull, and the force arrives as a wrench at the attachment rather
   * than as a torque at the joint (M-ADR-003). A scenario that does not run muscles ignores this
   * rather than failing, so a script can ask without checking first.
   */
  drive(unit: string, level: number): void;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly profileId: string;
  readonly morphology: Morphology;
  readonly durationSeconds: number;
  /**
   * Run the muscle set, so `api.drive` reaches something.
   *
   * Off by default: most scenarios are about the skeleton, and every unit costs a solve per tick.
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
   * Per-scenario tolerance overrides (spec 13.3: tolerances are per scenario). Each carries its
   * reason where it is set; the defaults live with the checks in the testkit.
   */
  readonly plausibility?: Readonly<Partial<Record<PlausibilityKey, number>>> | undefined;
  readonly conformance?: Readonly<Partial<Record<ConformanceKey, number>>> | undefined;
}

export type PlausibilityKey =
  | 'energyRisePerSample'
  | 'rangeViolation'
  | 'penetration'
  | 'restKinetic'
  | 'drift'
  | 'ballistic';
export type ConformanceKey = 'freeFlightCom' | 'restComHeight' | 'restKinetic' | 'dissipation';

const REFERENCE: Morphology = { sex: 0.5, stature: 1.7, mass: 70 };
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

/**
 * Which units a scenario script drives, by joint and direction.
 *
 * Named here rather than discovered, for the reason the studio's panel names them: the sign of a
 * moment arm is what the validation harness checks, and a scenario that grouped muscles by
 * measuring it would agree with that harness by construction rather than by being right.
 *
 * Ids, not objects: a scenario is data and must not depend on the muscle packages. What it names
 * is checked where it is used -- the runner refuses a unit the set does not have.
 */
const both = (...names: string[]): string[] => names.flatMap((n) => [`${n}_r`, `${n}_l`]);

const ELBOW_FLEXORS_R = [
  'biceps_brachii_long_r',
  'biceps_brachii_short_r',
  'brachialis_r',
  'brachioradialis_r',
];
const ELBOW_FLEXORS_L = ELBOW_FLEXORS_R.map((id) => id.replace(/_r$/, '_l'));
const ELBOW_EXTENSORS_R = [
  'triceps_brachii_long_r',
  'triceps_brachii_lateral_r',
  'triceps_brachii_medial_r',
];
const ELBOW_EXTENSORS_L = ELBOW_EXTENSORS_R.map((id) => id.replace(/_r$/, '_l'));

/** The groups the range-of-motion scenario takes through their range, in order. */
export {
  MUSCLE_GROUPS,
  driveForSlider,
  type DriveGroup,
  type DriveSection,
} from './muscleGroups.js';

/**
 * The four groups the range-of-motion scenario cycles through. Its own list, not the full drive
 * table: the table grew to cover every unit, and this scenario's golden trajectory was baked
 * against these four.
 */
const RANGE_OF_MOTION_GROUPS: readonly { readonly title: string; readonly units: string[] }[] = [
  { title: 'Elbow flexors', units: [...ELBOW_FLEXORS_R, ...ELBOW_FLEXORS_L] },
  { title: 'Elbow extensors', units: [...ELBOW_EXTENSORS_R, ...ELBOW_EXTENSORS_L] },
  {
    title: 'Knee flexors',
    units: both(
      'biceps_femoris_long',
      'biceps_femoris_short',
      'semitendinosus',
      'semimembranosus',
      'gastrocnemius_lateral',
      'gastrocnemius_medial',
    ),
  },
  {
    title: 'Knee extensors',
    units: both('rectus_femoris', 'vastus_lateralis', 'vastus_medialis', 'vastus_intermedius'),
  },
];

/**
 * What a quietly standing person's muscles are actually doing, as a fraction of maximum.
 *
 * Standing still is not passive and it is not hard either. The line of gravity falls a few
 * centimetres in front of the ankle, so the calf works continuously to stop the body toppling
 * forward, and that is most of the story: soleus carries it, with gastrocnemius helping. Above
 * the ankle the joints sit near the positions their own ligaments hold -- the knee is close to
 * locked in extension and the hip near its own passive limit -- so the big muscles there are
 * nearly silent, and what is left is postural tone: a few per cent in the back extensors and the
 * abdominal wall to hold the trunk up, a few per cent in the hip abductors to keep the pelvis
 * level over one leg's worth of stance width.
 *
 * The numbers are quiet-stance EMG as a fraction of a maximal contraction, in the band the
 * textbook measurements report (Winter 2009, and Basmajian's survey before it): soleus around a
 * tenth, gastrocnemius half that, the trunk and hip stabilisers a few per cent, tibialis anterior
 * barely on -- it alternates with the calf as the body sways rather than pulling steadily.
 *
 * These are a *posture*, not a controller. Nothing here corrects a sway, so the body standing on
 * them drifts the way a person standing on a numbed leg does. The scenario says so.
 */
export const POSTURAL_TONE: Readonly<Record<string, number>> = {
  soleus: 0.08,
  gastrocnemius_lateral: 0.04,
  gastrocnemius_medial: 0.04,
  tibialis_anterior: 0.02,
  tibialis_posterior: 0.03,
  fibularis_longus: 0.02,
  erector_spinae: 0.04,
  rectus_abdominis: 0.02,
  external_oblique: 0.02,
  internal_oblique: 0.02,
  gluteus_maximus_superior: 0.02,
  gluteus_maximus_middle: 0.02,
  gluteus_maximus_inferior: 0.02,
  gluteus_medius_anterior: 0.04,
  gluteus_medius_middle: 0.04,
  gluteus_medius_posterior: 0.04,
  gluteus_minimus_anterior: 0.02,
  gluteus_minimus_middle: 0.02,
  gluteus_minimus_posterior: 0.02,
  iliacus: 0.03,
  psoas_major: 0.03,
  vastus_lateralis: 0.02,
  vastus_medialis: 0.02,
  vastus_intermedius: 0.02,
  rectus_femoris: 0.02,
  biceps_femoris_long: 0.02,
  semitendinosus: 0.02,
  semimembranosus: 0.02,
};

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

/** Lean, in metres, that the reflex holds the body at: gravity in front of the ankle. */
const STANCE_LEAN = 0.04;
/** Excitation added per metre of lean past that, and per metre per second of sway. */
const LEAN_GAIN = 9;
const SWAY_GAIN = 2.2;
/**
 * Which half of the ankle strategy a muscle belongs to; anything unlisted is tone only.
 *
 * Only the ankle. A hip channel was tried on the same measurement taken at the pelvis -- hip
 * flexors against a forward overhang, extensors against a backward one, which is the hip strategy
 * as it is usually described -- and it did not help: the body went over at the same second either
 * way, and with the gain high enough to matter it went over sooner. Holding a hip needs a servo
 * that knows the joint's own angle, and a scenario script can see segment positions and nothing
 * else. OQ-024.
 */
const REFLEX_CHANNEL: Readonly<Record<string, 'calf' | 'shin'>> = {
  soleus: 'calf',
  gastrocnemius_lateral: 'calf',
  gastrocnemius_medial: 'calf',
  tibialis_anterior: 'shin',
};

/**
 * The ankle strategy, which is how a person stands still.
 *
 * Quiet standing is not a posture held by tone alone. The body is an inverted pendulum with its
 * mass a metre up and its base the length of a foot, and the tone in `POSTURAL_TONE` is what it
 * takes to hold that *at the lean it is already at* -- change the lean and the same tone is
 * either too much or not enough, and the pendulum runs away. Driven on tone alone this body
 * stands for about seven tenths of a second and then goes over, which is the right answer to the
 * wrong question: it is what standing without the reflex that watches it looks like.
 *
 * So the calf is modulated by the sway. Lean is measured as the head over the ankles along the
 * foot's own anterior direction -- taken from the foot rather than from the world, so it stays
 * right if the body turns -- and the calf takes the forward half of it while tibialis anterior
 * takes the backward half, each with a term in the lean and a term in its rate. That is the
 * ankle strategy as the posture literature describes it, and nothing above the ankle is in the
 * loop: no hip strategy, no stepping, no vestibular anything. Push this body hard enough and it
 * falls over, which is correct.
 *
 * `reflex` at zero turns the loop off and leaves the tone, which is the comparison.
 */
function ankleStrategy(v: Record<string, number>): (time: number, api: ScenarioApi) => void {
  let previousLean: number | undefined;
  let previousTime = 0;
  return (time, api) => {
    const settle = v.settle as number;
    const ramp = settle <= 0 ? 1 : Math.min(1, time / settle);
    const tone = (v.tone as number) * ramp;

    const head = api.segmentPosition(api.segment('head'));
    const heel = api.segmentPosition(api.segment('calcaneus_r'));
    const toe = api.segmentPosition(api.segment('forefoot_r'));
    // The foot's own forward, flattened and normalised. A foot is never exactly level, and a
    // lean measured along a tilted axis picks up the body's height as if it were sway.
    const ax = toe.x - heel.x;
    const az = toe.z - heel.z;
    const length = Math.hypot(ax, az) || 1;
    const ankle = api.segmentPosition(api.segment('talus_r'));
    const lean = ((head.x - ankle.x) * ax + (head.z - ankle.z) * az) / length;
    const dt = time - previousTime;
    const rate = previousLean === undefined || dt <= 0 ? 0 : (lean - previousLean) / dt;
    previousLean = lean;
    previousTime = time;

    const gain = (v.reflex as number) * ramp;
    const excess = lean - STANCE_LEAN;
    const forward = gain * (LEAN_GAIN * Math.max(0, excess) + SWAY_GAIN * Math.max(0, rate));
    const backward = gain * (LEAN_GAIN * Math.max(0, -excess) + SWAY_GAIN * Math.max(0, -rate));

    for (const [muscle, level] of Object.entries(POSTURAL_TONE)) {
      const reflex = REFLEX_CHANNEL[muscle];
      const added = reflex === 'calf' ? forward : reflex === 'shin' ? backward : 0;
      for (const unit of both(muscle)) api.drive(unit, Math.min(1, tone * level + added));
    }
  };
}

export const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  define({
    id: 'quiet-standing',
    title: 'Standing quietly',
    description:
      'The rest pose on the ground with the muscles at the tone a quietly standing person holds ' +
      'them at -- mostly calf, a few per cent everywhere else -- with the calf modulated by the ' +
      'sway, which is the ankle strategy and as much of standing as this can hold. Nothing above ' +
      'the ankle is in the loop, so it stands for about a second and then goes over. That is ' +
      'what standing looks like with the tone right and the reflexes missing (OQ-024).',
    parameters: [
      param('tone', 'Postural tone', 1, 0, 3, 0.05, '\u00d7'),
      param('reflex', 'Ankle reflex', 1, 0, 3, 0.05, '\u00d7'),
      param('settle', 'Ramp in over', 0.25, 0, 2, 0.05, ' s'),
    ],
    make: (v) => ({
      profileId: 'l3_anatomical',
      morphology: REFERENCE,
      muscles: true,
      durationSeconds: 3,
      // On the ground rather than above it: this one is about what the muscles hold, and a drop
      // would be about the landing.
      clearance: 0,
      ground: { height: 0 },
      passiveJoints: true,
      // A muscle is a source of energy, so the passive-system check does not apply.
      passiveSystem: false,
      // It is still moving at the end because it never stops: a body with no balance reflex on
      // a set of tonic excitations sways and keeps swaying.
      plausibility: { restKinetic: 30 },
      script: ankleStrategy(v),
    }),
  }),
  define({
    id: 'drop-standing-collapse',
    title: 'Drop, standing',
    description: 'The rest pose released above the ground. It should buckle and settle.',
    parameters: [param('clearance', 'Drop height', 0.3, 0, 1.5, 0.05)],
    make: (v) => ({
      profileId: 'l1_standard',
      morphology: REFERENCE,
      durationSeconds: 3,
      clearance: v.clearance as number,
      ground: { height: 0 },
      passiveJoints: true,
      passiveSystem: true,
      // Landing upright on two feet is the hardest impact of any scenario: 230 J leaves the
      // ledger in a single 20 ms sample, the contact compresses about a centimetre, and the
      // sample after it the contact spring returns a few joules of that as it pushes the body
      // back out. The rise is 2% of the impact, it happens once, and the body settles
      // immediately afterwards, so it is a soft contact behaving as designed rather than the
      // runaway this check exists to catch.
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
      // Which step the body comes to rest on is chaotic, so resting heights can differ by a few
      // steps between backends; a whole flight is a metre, and that would be a bug.
      conformance: { restComHeight: 0.6 },
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
      // Captured on the first tick: where the head was before anything shook it. Held in the
      // closure rather than recomputed, so the shake is about a fixed point and not about
      // wherever the head has drifted to.
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
        // It is still being shaken when the run ends, so of course it is still moving. Two joules
        // on a 70 kg body is a head vibrating a couple of millimetres, which is the scenario
        // doing exactly what it was written to do.
        plausibility: { restKinetic: 4 },
        script: (time, api) => {
          const head = api.segment('head');
          if (head < 0) return;
          if (centre === undefined) {
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
      // The release flings the body into the ground at a few metres per second; the impulse
      // solver lets a capsule sink a little further than a drop does before it pushes back.
      plausibility: { penetration: 0.06 },
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
  define({
    id: 'muscle-range-of-motion',
    title: 'Range of motion, muscle by muscle',
    description:
      'The body hangs by one wrist and each driven group takes its joint through its range in ' +
      'turn: elbows flexed then straightened, knees the same. Nothing is scripted at the joints ' +
      "-- the only inputs are muscle excitations, and what the joints do is what the muscles' " +
      'own leverage makes them do.',
    parameters: [
      param('hold', 'Hand height', 2.2, 1.2, 2.6, 0.05),
      param('phase', 'Seconds a group', 3, 1, 8, 0.5, ' s'),
    ],
    make: (v) => ({
      profileId: 'l3_anatomical',
      morphology: REFERENCE,
      muscles: true,
      durationSeconds: 2 + 4 * (v.phase as number),
      clearance: 0.2,
      ground: { height: 0 },
      passiveJoints: true,
      // A muscle is a source of energy, so the passive-system check does not apply.
      passiveSystem: false,
      // The last group is still driving when the run ends and the body hangs from one wrist, so
      // it is still swinging: three joules on a 70 kg body is the pendulum a driven limb makes of
      // it, which is the scenario doing what it was written to do.
      plausibility: { restKinetic: 4 },
      script: (time, api) => {
        const hand = api.segment('hand_r');
        if (time === 0) api.grab(hand, vec3(0, 0, 0), vec3(0.2, v.hold as number, 0));
        // A second to settle on the grab, then each group in turn. Ramped rather than switched:
        // a step to full excitation is a transient nobody asked to look at, and a muscle that
        // has to follow a step tells you about the step.
        const phase = v.phase as number;
        const since = time - 1;
        const group = Math.floor(since / phase);
        const within = (since - group * phase) / phase;
        const level = since < 0 ? 0 : Math.sin(Math.PI * Math.min(1, Math.max(0, within)));
        for (let at = 0; at < RANGE_OF_MOTION_GROUPS.length; at++) {
          const units = RANGE_OF_MOTION_GROUPS[at]?.units ?? [];
          for (const unit of units) api.drive(unit, at === group ? level : 0);
        }
      },
    }),
  }),
  define({
    id: 'arm-flail',
    title: 'Flail the arms',
    description:
      'Both elbows driven by sine waves, the flexors and extensors in opposition and the two ' +
      'arms half a cycle apart. What it is for is watching the paths and the bellies move under ' +
      'a signal that never settles, which is where a wrap that flickers or a belly that lags ' +
      'shows itself.',
    parameters: [
      param('frequency', 'Flail rate', 1.5, 0.2, 6, 0.1, ' Hz'),
      param('depth', 'Drive depth', 0.8, 0.1, 1, 0.05),
      param('hold', 'Hand height', 2.2, 1.2, 2.6, 0.05),
    ],
    make: (v) => ({
      profileId: 'l3_anatomical',
      morphology: REFERENCE,
      muscles: true,
      durationSeconds: 8,
      clearance: 0.2,
      ground: { height: 0 },
      passiveJoints: true,
      passiveSystem: false,
      // It is still flailing when the run ends, by construction: the drive never stops and the
      // body hangs from one wrist while two arms swing.
      plausibility: { restKinetic: 8 },
      script: (time, api) => {
        // Held by the left wrist, so the right arm is the one flailing freely.
        const hand = api.segment('hand_l');
        if (time === 0) api.grab(hand, vec3(0, 0, 0), vec3(-0.2, v.hold as number, 0));
        const depth = v.depth as number;
        const wave = 2 * Math.PI * (v.frequency as number) * time;
        // Cosine, so the drive starts at full rather than at zero: a sine through zero at t = 0
        // spends the first tick doing nothing, which is exactly the mistake the Nyquist test
        // caught in the skull shake.
        const right = (Math.cos(wave) + 1) / 2;
        const left = (Math.cos(wave + Math.PI) + 1) / 2;
        for (const unit of ELBOW_FLEXORS_R) api.drive(unit, depth * right);
        for (const unit of ELBOW_EXTENSORS_R) api.drive(unit, depth * (1 - right));
        for (const unit of ELBOW_FLEXORS_L) api.drive(unit, depth * left);
        for (const unit of ELBOW_EXTENSORS_L) api.drive(unit, depth * (1 - left));
      },
    }),
  }),
];

/**
 * The one a tool should open on, unless it has a reason not to.
 *
 * Named here rather than "the first definition", so that adding a scenario at the top of the list
 * does not silently change what every consumer opens with.
 */
export const DEFAULT_SCENARIO = 'quiet-standing';

/** The committed scenario set: every definition at its default parameters (spec 13.5). */
export const SCENARIOS: readonly Scenario[] = SCENARIO_DEFINITIONS.map((d) => d.build());

export function scenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`No scenario '${id}'. Known: ${SCENARIOS.map((x) => x.id).join(', ')}.`);
  return s;
}

export * from './place.js';
export * from './reports.js';
