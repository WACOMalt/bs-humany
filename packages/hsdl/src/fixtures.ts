/**
 * A minimal but structurally complete HSDL document, for tests.
 *
 * Three bones, one joint, one fidelity profile. Deliberately tiny: its job is to exercise the
 * validation and round-trip machinery, not to describe anatomy.
 *
 * **The numbers here are not anthropometry.** They are round figures chosen to make assertions
 * readable, and they carry a `provisional` citation saying exactly that, so this file can never be
 * mistaken for a data source or quietly harvested into the real skeleton package.
 */

import { provisional } from './citation.js';
import type { HsdlDocument } from './document.js';
import { mul, param } from './expr.js';
import { HSDL_VERSION } from './namespace.js';
import { IDENTITY_TRANSFORM_DATA } from './primitives.js';

const testValue = (what: string) =>
  provisional(
    'gordon2014',
    'OQ-000',
    `Test fixture only. ${what} is a round number chosen for readable assertions, not an ` +
      'anthropometric measurement. Never copy a value from this file into a real model.',
  );

export function makeMinimalDocument(): HsdlDocument {
  return {
    hsdlVersion: HSDL_VERSION,
    id: 'test.minimal',
    meta: {
      name: 'Minimal test body',
      description: 'Three bones and one joint. Exercises validation, not anatomy.',
      sources: [testValue('every value in this document')],
      convention: 'world',
    },
    units: { length: 'm', mass: 'kg', angle: 'rad', time: 's', force: 'N' },

    bones: [
      {
        id: 'pelvis',
        ta: 'Pelvis',
        displayName: 'Pelvis',
        parent: null,
        region: 'pelvis',
        restTransform: IDENTITY_TRANSFORM_DATA,
        dimensions: { width: mul(0.16, param('stature')) },
        geometry: { kind: 'box', size: { x: 0.28, y: 0.18, z: 0.16 } },
      },
      {
        id: 'femur_r',
        ta: 'Os femoris',
        displayName: 'Right femur',
        parent: 'pelvis',
        side: 'right',
        region: 'thigh',
        restTransform: {
          translation: { x: 0.09, y: -0.06, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
        dimensions: { length: mul(0.245, param('stature')) },
        geometry: {
          kind: 'capsule',
          length: mul(0.245, param('stature')),
          radiusProximal: 0.03,
          radiusDistal: 0.025,
        },
      },
      {
        id: 'tibia_r',
        ta: 'Tibia',
        displayName: 'Right tibia',
        parent: 'femur_r',
        side: 'right',
        region: 'leg',
        restTransform: {
          translation: { x: 0, y: -0.42, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
        dimensions: { length: mul(0.246, param('stature')) },
        geometry: { kind: 'capsule', length: mul(0.246, param('stature')), radiusProximal: 0.025 },
      },
    ],

    landmarks: [
      {
        id: 'femur_r__hip_centre',
        bone: 'femur_r',
        displayName: 'Right hip joint centre',
        position: { x: 0, y: 0, z: 0 },
        source: testValue('this landmark position'),
      },
      {
        id: 'femur_r__knee_centre',
        bone: 'femur_r',
        displayName: 'Right knee joint centre',
        position: { x: 0, y: -0.42, z: 0 },
        source: testValue('this landmark position'),
      },
      {
        id: 'femur_r__epicondyle_medial',
        bone: 'femur_r',
        displayName: 'Right medial femoral epicondyle',
        position: { x: -0.04, y: -0.42, z: 0 },
        source: testValue('this landmark position'),
        palpable: true,
      },
      {
        id: 'femur_r__epicondyle_lateral',
        bone: 'femur_r',
        displayName: 'Right lateral femoral epicondyle',
        position: { x: 0.04, y: -0.42, z: 0 },
        source: testValue('this landmark position'),
        palpable: true,
      },
    ],

    joints: [
      {
        id: 'knee_r',
        displayName: 'Right knee',
        parentBone: 'femur_r',
        childBone: 'tibia_r',
        type: 'revolute',
        frame: {
          translation: { x: 0, y: -0.42, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
        dofs: [
          {
            axis: 'flexion',
            kind: 'hinge',
            vector: { x: 1, y: 0, z: 0 },
            range: [-2.0, 0],
            neutral: 0,
            passiveDamping: 0.5,
            romSource: testValue('this range of motion'),
          },
        ],
        reportingOrder: 'zxy',
      },
    ],

    segmentation: [
      {
        id: 'l0_ragdoll',
        displayName: 'L0 ragdoll',
        description: 'Everything below the pelvis lumped into one leg segment.',
        segments: [
          { id: 'pelvis', displayName: 'Pelvis', anchor: 'pelvis', bones: ['pelvis'] },
          {
            id: 'leg_r',
            displayName: 'Right leg',
            anchor: 'femur_r',
            bones: ['femur_r', 'tibia_r'],
          },
        ],
        limitations: ['The knee does not articulate at this fidelity.'],
      },
      {
        id: 'l1_standard',
        displayName: 'L1 standard',
        description: 'Femur and tibia as separate bodies, so the knee articulates.',
        segments: [
          { id: 'pelvis', displayName: 'Pelvis', anchor: 'pelvis', bones: ['pelvis'] },
          { id: 'thigh_r', displayName: 'Right thigh', anchor: 'femur_r', bones: ['femur_r'] },
          { id: 'shank_r', displayName: 'Right shank', anchor: 'tibia_r', bones: ['tibia_r'] },
        ],
        joints: ['knee_r'],
        limitations: ['Knee translation is not modelled; flexion only.'],
      },
    ],

    collisionProxies: [],
    contactRules: {
      classes: { bone_on_ground: { friction: 0.8, restitution: 0.05 } },
      defaultClass: 'bone_on_ground',
    },
    constraints: [],

    morphology: {
      default: { sex: 0.5, stature: 1.7, mass: 70 },
      statureRange: [1.4, 2.05],
      massRange: [35, 150],
      populations: [
        {
          describes: 'Test fixture',
          limitation: 'Not a real population. This document is a unit-test fixture.',
          source: testValue('this population note'),
        },
      ],
    },

    attachmentSites: [],
  };
}
