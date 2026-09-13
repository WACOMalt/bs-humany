/**
 * Small hand-built articulations for backend tests: a single hinge under a very heavy root box
 * resting on the ground, so the root stays put on either backend without a kinematic switch and
 * the arm feels gravity. Init the backend with `ground: { height: PENDULUM_GROUND }`.
 */

import { type CompiledArticulation, ROOT_NQ, ROOT_NV } from '@bs-humany/compiler';
import { IDENTITY_QUAT, vec3 } from '@bs-humany/frames';

export interface PendulumOptions {
  readonly range?: [number, number] | undefined;
  readonly gravity?: number | undefined;
  /** Arm mass, kg; its centre sits 0.25 m below the hinge. */
  readonly mass?: number | undefined;
}

/** An unspecified optional passive term; the fixture carries no model values. */
const NONE = 0;

export const PENDULUM_ARM = 0.25;
/** The root box is a metre tall about y = 2, so its base sits here. */
export const PENDULUM_GROUND = 1.5;

export function pendulum(options: PendulumOptions = {}): CompiledArticulation {
  const range = options.range ?? [-3, 3];
  const mass = options.mass ?? 1;
  const dofs = [
    {
      index: 0,
      joint: 0,
      axisName: 'flexion',
      kind: 'hinge' as const,
      vector: vec3(0, 0, 1),
      range,
      neutral: 0,
      passiveDamping: NONE,
      armature: NONE,
      frictionLoss: NONE,
    },
  ];
  return {
    documentId: 'test',
    profileId: 'pendulum',
    morphologyKey: 'test',
    segments: [
      {
        index: 0,
        id: 'root',
        displayName: 'Root',
        anchor: 'root',
        bones: ['root'],
        parent: -1,
        restWorld: { translation: vec3(0, 2, 0), rotation: IDENTITY_QUAT },
        mass: 1e6,
        com: vec3(0, 0, 0),
        inertia: [1e6, 0, 0, 0, 1e6, 0, 0, 0, 1e6] as never,
        proxyIndices: [0],
        followers: [],
      },
      {
        index: 1,
        id: 'arm',
        displayName: 'Arm',
        anchor: 'arm',
        bones: ['arm'],
        parent: 0,
        restWorld: { translation: vec3(0, 2 - PENDULUM_ARM, 0), rotation: IDENTITY_QUAT },
        mass,
        com: vec3(0, 0, 0),
        inertia: [0.01 * mass, 0, 0, 0, 0.001 * mass, 0, 0, 0, 0.01 * mass] as never,
        proxyIndices: [],
        followers: [],
      },
    ],
    joints: [
      {
        index: 0,
        id: 'hinge',
        displayName: 'Hinge',
        parentSegment: 0,
        childSegment: 1,
        parentBone: 'root',
        childBone: 'arm',
        frameInParent: { translation: vec3(0, 0, 0), rotation: IDENTITY_QUAT },
        frameInChild: { translation: vec3(0, PENDULUM_ARM, 0), rotation: IDENTITY_QUAT },
        dofs,
        dofStart: 0,
        type: 'revolute',
      },
    ],
    dofs,
    proxies: [
      {
        index: 0,
        id: 'root_box',
        segment: 0,
        transform: { translation: vec3(0, 0, 0), rotation: IDENTITY_QUAT },
        shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) },
        group: 1,
        mask: 0xffffffff,
        contactClass: 'ground',
      },
    ],
    contactClasses: { ground: { friction: 1, restitution: 0, softness: 0 } },
    excludedPairs: [[0, 1]],
    constraints: [],
    nv: ROOT_NV + 1,
    nq: ROOT_NQ + 1,
    root: 0,
    gravity: vec3(0, -(options.gravity ?? 9.80665), 0),
    totalMass: 1e6 + mass,
  };
}
