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
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly profileId: string;
  readonly morphology: Morphology;
  readonly durationSeconds: number;
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
];

/** The committed scenario set: every definition at its default parameters (spec 13.5). */
export const SCENARIOS: readonly Scenario[] = SCENARIO_DEFINITIONS.map((d) => d.build());

export function scenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`No scenario '${id}'. Known: ${SCENARIOS.map((x) => x.id).join(', ')}.`);
  return s;
}

export * from './place.js';
export * from './reports.js';
