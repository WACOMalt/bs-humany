/**
 * A status as a publisher writes it, with every field of the contract filled: what
 * `pnpm generate:pose-bridge-fixture` writes to `apps/xr-viewer/fixtures/status.json` for the
 * Rust side's test to parse and pin.
 *
 * Complete rather than merely a `PanelStatus`: every optional key at every depth has to be here,
 * so a field added to the contract cannot be left out of the fixture, and a field renamed in the
 * contract fails to compile here until the sample is renamed too -- after which the regenerated
 * fixture carries the new name, and the Rust test, which asserts a value from every field it
 * reads, fails until the reader follows. The values are chosen to be none of the defaults the
 * Rust side falls back on, so a key it no longer finds shows up as a wrong number rather than
 * passing as a zero.
 *
 * Types from the contract and one table, the slider bounds, which is data every publisher sends
 * as it stands: the generator loads this with jiti, and nothing here may pull in a runtime that
 * needs a browser or Tauri. So a bound edited in the table reaches the fixture when the fixture is
 * regenerated, and the Rust side's slider test runs against the bounds the headset will be sent.
 *
 * It sits beside `publisherStatus.ts`, which builds the real status against the same contract. It
 * used to sit in the studio's source, which put a generator in `tools/` inside the app; it is not
 * in the package's exports, because the generator is the only reader and loads this file by path.
 */

import type { PanelStatus } from '@bs-humany/pose-bridge/codec';
import { CONTROL_RANGES } from '@bs-humany/scenarios';

/** T with every optional key made required, all the way down. */
type Complete<T> = T extends readonly (infer U)[]
  ? readonly Complete<U>[]
  : T extends object
    ? { readonly [K in keyof T]-?: Complete<T[K]> }
    : T;

export const PANEL_STATUS_SAMPLE = {
  generation: 1_790_000_000_003,
  scenario: {
    id: 'drop-standing-collapse',
    title: 'Drop and collapse',
    description: 'The rest pose dropped onto the ground with nothing holding it up.',
  },
  scenarios: [
    {
      id: 'tilting-floor',
      title: 'Tilting floor',
      description: 'The rest pose on a floor that pitches and rolls under it in small pulses.',
    },
    {
      id: 'drop-standing-collapse',
      title: 'Drop and collapse',
      description: 'The rest pose dropped onto the ground with nothing holding it up.',
    },
  ],
  profiles: [
    { id: 'l1_standard', title: 'L1 — Standard (23 bodies, 500 Hz)' },
    { id: 'l3_anatomical', title: 'L3 — Anatomical (~135 bodies, 1000 Hz)' },
  ],
  profile: 'l3_anatomical',
  simSeconds: 1.5,
  wallSeconds: 6.25,
  speed: 0.24,
  paused: true,
  muscles: true,
  holding: ['radius_r'],
  grabStrength: 1.5,
  stepsPerSecond: 1000,
  fps: 90,
  settings: {
    muscles: true,
    sex: 0.25,
    stature: 1.62,
    mass: 58,
    crural: 1.02,
    brachial: 0.77,
    legLength: 1.03,
    percentile: 0.4,
    dropHeight: 0.35,
    passive: true,
    redistribute: true,
    gravity: true,
    floor: true,
    fps: 90,
    stepsPerSecond: 1000,
  },
  driveGroups: [
    { title: 'Elbow flexors', level: 20, section: 'Arm' },
    { title: 'Knee extensors', level: 5, section: 'Leg' },
  ],
  diagnostics: {
    kinetic: 12.5,
    potential: 580.25,
    driftMm: 0.75,
    limitsWorst: 0.625,
    violations: 2,
    contacts: 14,
    costMs: 0.875,
  },
  groundHeight: -0.05,
  staticBoxes: [
    { halfExtents: [0.5, 0.25, 0.3], position: [0, 0.25, -0.4], rotation: [0, 0, 0, 1] },
  ],
  tension: [0.125, 0.5],
  tissue: {
    discs: [
      {
        bone: 'sacrum',
        kind: 'disc',
        position: [0.017, 0.013, -0.051],
        rotation: [-0.018, 0.6, -0.018, 0.8],
      },
    ],
    bars: [
      {
        boneA: 'sternum',
        localA: [0.02, 0.07, 0.04],
        boneB: 'rib_2_r',
        localB: [-0.01, -0.05, -0.07],
      },
    ],
  },
  mode: 'running',
  overlays: { muscles: true, tissue: false },
  scenarioParameters: [
    { id: 'clearance', title: 'Drop height', value: 0.3, min: 0, max: 1.5, step: 0.05, unit: 'm' },
  ],
  muscleReadout: { 'section.arm': '310 N', loaded: '12 of 234' },
  controls: CONTROL_RANGES,
  brain: {
    serverUp: true,
    active: true,
    authority: 0.3,
    selected: 'stand-7',
    checkpoints: [{ id: 'stand-7', name: 'stand, generation 7' }],
    fit: 'In the loop',
    training: 'generation 7, fitness 0.812',
    trainingRunning: true,
    trainingStoppable: true,
    following: true,
    // Two regions with a stretch of their own and three following the base, so the reader is
    // held to both: a named region's value, and the base for one that is not named.
    reflex: {
      stretch: 2.5,
      velocity: 0.125,
      setPoint: 0.875,
      inhibition: 0.5,
      delaySeconds: 0.03,
      regionStretch: { Arm: 1.25, Leg: 6.5 },
    },
    memory: 8,
    canStart: false,
    canStop: true,
    canHandOver: true,
    canRelease: false,
    canSetUp: true,
    canUndoSetUp: true,
    policyNote: 'No dashboard server: checkpoints trained here are kept in this browser.',
    spineNote: 'Stretch and Damping at zero is a body with no reflexes at all.',
  },
  training: { task: 'stand', episode: 4, generation: 7, fitness: 0.812 },
  recordedSeconds: 2.75,
  playing: true,
  live: false,
} as const satisfies Complete<PanelStatus>;
