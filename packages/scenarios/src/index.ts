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

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'drop-standing-collapse',
    title: 'Drop, standing',
    description: 'The rest pose released 0.3 m above the ground. It should buckle and settle.',
    profileId: 'l1_standard',
    morphology: REFERENCE,
    durationSeconds: 3,
    clearance: 0.3,
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
  },
  {
    id: 'drop-supine',
    title: 'Drop, supine',
    description: 'Lying face up, released 0.5 m above the ground. It should land flat and stay.',
    profileId: 'l1_standard',
    morphology: REFERENCE,
    durationSeconds: 3,
    rootRotation: SUPINE,
    clearance: 0.5,
    ground: { height: 0 },
    passiveJoints: true,
    passiveSystem: true,
  },
  {
    id: 'drop-prone',
    title: 'Drop, prone',
    description: 'Lying face down, released 0.5 m above the ground.',
    profileId: 'l1_standard',
    morphology: REFERENCE,
    durationSeconds: 3,
    rootRotation: PRONE,
    clearance: 0.5,
    ground: { height: 0 },
    passiveJoints: true,
    passiveSystem: true,
  },
  {
    id: 'stairs-tumble',
    title: 'Stairs tumble',
    description: 'Released standing at the top of six steps, leaning forward so it goes down them.',
    profileId: 'l1_standard',
    morphology: REFERENCE,
    durationSeconds: 4,
    rootRotation: fromAxisAngle(vec3(1, 0, 0), -0.35),
    clearance: 1.1,
    ground: { height: 0 },
    staticBoxes: stairs(6, 0.17, 0.28, 2),
    passiveJoints: true,
    passiveSystem: true,
    // Which step the body comes to rest on is chaotic, so resting heights can differ by a few
    // steps between backends; a whole flight is a metre, and that would be a bug.
    conformance: { restComHeight: 0.6 },
  },
  {
    id: 'hang-from-wrist',
    title: 'Hang from a wrist',
    description: 'The right hand is held 2.1 m up for the whole run; the body hangs and settles.',
    profileId: 'l1_standard',
    morphology: REFERENCE,
    durationSeconds: 6,
    clearance: 0.2,
    ground: { height: 0 },
    passiveJoints: true,
    passiveSystem: false,
    script: (time, api) => {
      const hand = api.segment('hand_r');
      if (time === 0) api.grab(hand, vec3(0, 0, 0), vec3(0.2, 2.1, 0));
    },
  },
  {
    id: 'seated-on-box',
    title: 'Onto a box',
    description:
      'Released standing beside a knee-high box so the collapse lands the pelvis on it. Not a ' +
      'seated pose: joints cannot be posed directly in reduced coordinates, so the seat is earned.',
    profileId: 'l1_standard',
    morphology: REFERENCE,
    durationSeconds: 3,
    rootRotation: fromAxisAngle(vec3(1, 0, 0), 0.25),
    clearance: 0.25,
    ground: { height: 0 },
    staticBoxes: [
      { id: 'seat', halfExtents: vec3(0.3, 0.22, 0.25), position: vec3(0, 0.22, 0.35) },
    ],
    passiveJoints: true,
    passiveSystem: true,
  },
  {
    id: 'grab-and-swing',
    title: 'Grab and swing',
    description:
      'The right hand is grabbed, swung in a horizontal circle for two seconds, and released.',
    profileId: 'l1_standard',
    morphology: REFERENCE,
    durationSeconds: 4,
    clearance: 0.2,
    ground: { height: 0 },
    passiveJoints: true,
    passiveSystem: false,
    // The release flings the body into the ground at a few metres per second; the impulse
    // solver lets a capsule sink a little further than a drop does before it pushes back.
    plausibility: { penetration: 0.06 },
    script: (time, api) => {
      const hand = api.segment('hand_r');
      if (time === 0) api.grab(hand, vec3(0, 0, 0), vec3(0.6, 1.5, 0));
      else if (time < 2)
        api.moveGrab(vec3(0.6 * Math.cos(time * Math.PI), 1.5, 0.6 * Math.sin(time * Math.PI)));
      else if (time < 2.01) api.release();
    },
  },
];

export function scenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`No scenario '${id}'. Known: ${SCENARIOS.map((x) => x.id).join(', ')}.`);
  return s;
}

export * from './place.js';
export * from './reports.js';
