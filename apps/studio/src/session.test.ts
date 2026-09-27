/**
 * A session holds every setting that defines a run, and a saved run goes back into a fresh studio.
 *
 * The first format kept the body and the scene and left out the step rate and the muscles, so a
 * session saved at 2000 steps a second, or with muscles off, failed to restore in a fresh studio
 * with the kernel's complaint about `dt` or channel lists. These pin the second format's fields
 * through a file, the first format's filling-in, and the sentences a refused restore is shown as.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { PASSIVE_JOINT_MODULE_ID } from '@bs-humany/modules-mechanics';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import {
  type ChannelPrint,
  RESTORE_REFUSED,
  type RunPrint,
  SESSION_FORMAT,
  type SessionFile,
  type SessionSettings,
  channelPrints,
  deserializeSnapshot,
  inferRunSettings,
  isSessionFile,
  normaliseSettings,
  restoreMismatch,
  savedRunPrint,
  serializeSnapshot,
  sessionFormatOf,
} from './session.js';
import { DEFAULT_OUTPUT_FRAMERATE, Simulation } from './simulation.js';

/** Every field a session of the second format can carry, none of them at its default. */
const EVERYTHING: SessionSettings = {
  sex: 0.2,
  stature: 1.82,
  mass: 81.5,
  profile: 'l1_standard',
  backend: 'mujoco',
  scenario: 'quiet-standing',
  passive: false,
  redistribute: false,
  dropHeight: 0.75,
  grabStrength: 2.5,
  gravity: false,
  floor: false,
  scenarioParameters: { lean: 0.1 },
  muscles: false,
  stepsPerSecond: 2000,
  outputFramerate: 24,
  captureBudgetMiB: 512,
  drive: { 'drive-elbow-flexors': 40, 'drive-knee-extensors': 65 },
  reflex: { stretch: 2.1, velocity: 0.35, setPoint: -0.05, inhibition: 0.55, delaySeconds: 0.045 },
  brainAuthority: 0.8,
  checkpoint: 'stand-2026-09-20',
};

/** A session as the studio wrote them before the second format: no rate, no muscles. */
const FIRST_FORMAT = {
  format: 'bs-humany.session/1',
  savedAt: '2026-09-10T12:00:00.000Z',
  settings: {
    sex: 0.5,
    stature: 1.7,
    mass: 70,
    crural: 0.9,
    brachial: 0.8,
    legLength: 0.47,
    profile: 'l1_standard',
    backend: 'mujoco',
    scenario: '',
    passive: true,
    redistribute: true,
    dropHeight: 0.2,
  },
};

describe('a session file', () => {
  it('carries every setting that defines a run through JSON unchanged', () => {
    const file: SessionFile = {
      format: SESSION_FORMAT,
      savedAt: '2026-09-27T09:00:00.000Z',
      settings: EVERYTHING,
    };
    const read: unknown = JSON.parse(JSON.stringify(file));
    expect(isSessionFile(read)).toBe(true);
    if (!isSessionFile(read)) return;
    expect(normaliseSettings(read.settings)).toEqual(EVERYTHING);
  });

  it('of the first format still loads, filled in with the studio’s defaults', () => {
    const read: unknown = JSON.parse(JSON.stringify(FIRST_FORMAT));
    expect(isSessionFile(read)).toBe(true);
    if (!isSessionFile(read)) return;
    // The limb proportions load without complaint and go no further: nothing follows them.
    const { crural: _c, brachial: _b, legLength: _l, ...rest } = FIRST_FORMAT.settings;
    expect(normaliseSettings(read.settings)).toEqual({
      ...rest,
      grabStrength: 1,
      gravity: true,
      floor: true,
      muscles: true,
      outputFramerate: DEFAULT_OUTPUT_FRAMERATE,
      drive: {},
    });
  });

  it('is refused with the name of a setting it lacks, rather than applied half-way', () => {
    const { profile: _, ...noProfile } = FIRST_FORMAT.settings;
    expect(() => normaliseSettings(noProfile)).toThrow(/body profile/);
    expect(() => normaliseSettings({ ...FIRST_FORMAT.settings, stature: 'tall' })).toThrow(
      /stature/,
    );
  });

  it('keeps only a whole cord, and drops numbers that are not numbers', () => {
    const settings = normaliseSettings({
      ...FIRST_FORMAT.settings,
      reflex: { stretch: 1, velocity: 0.2, setPoint: 0 },
      drive: { a: 30, b: 'lots', c: null },
      outputFramerate: Number.NaN,
    });
    expect(settings.reflex).toBeUndefined();
    expect(settings.drive).toEqual({ a: 30 });
    expect(settings.outputFramerate).toBe(DEFAULT_OUTPUT_FRAMERATE);
  });

  it('from a newer studio is told apart from a file that is no session', () => {
    const newer = { ...FIRST_FORMAT, format: 'bs-humany.session/3' };
    expect(isSessionFile(newer)).toBe(false);
    expect(sessionFormatOf(newer)).toBe('bs-humany.session/3');
    expect(sessionFormatOf({ format: 'something-else/1' })).toBeUndefined();
    expect(sessionFormatOf([1, 2])).toBeUndefined();
  });
});

describe('a saved run', () => {
  it('says its rate and its muscles, which a file of the first format did not', () => {
    expect(inferRunSettings({ dt: 1 / 760, channels: { 'body.pose': 0 } })).toEqual({
      stepsPerSecond: 760,
      muscles: false,
    });
    expect(
      inferRunSettings({ dt: 1 / 1000, channels: { 'body.pose': 0, 'muscle.state': 0 } }),
    ).toEqual({ stepsPerSecond: 1000, muscles: true });
  });

  it('decides the rate and the muscles over what the settings say, since a restore needs them', () => {
    const settings = normaliseSettings(
      { ...FIRST_FORMAT.settings, muscles: false, stepsPerSecond: 500 },
      { dt: 1 / 2000, channels: { 'muscle.state': 0 } },
    );
    expect(settings.stepsPerSecond).toBe(2000);
    expect(settings.muscles).toBe(true);
  });
});

describe('restoreMismatch', () => {
  const channels: ChannelPrint[] = [
    ['body.pose', '1.0.0', 4096],
    ['muscle.state', '1.0.0', 8192],
  ];
  const RUN: RunPrint = {
    dt: 1 / 1000,
    channels,
    modules: ['bsums.xyz.bs-humany.physics', PASSIVE_JOINT_MODULE_ID],
  };

  it('finds nothing when the runs match, with or without the versions', () => {
    expect(restoreMismatch(RUN, RUN)).toBeUndefined();
    const unversioned = channels.map(([id, , bytes]) => [id, undefined, bytes] as const);
    expect(restoreMismatch({ ...RUN, channels: unversioned }, RUN)).toBeUndefined();
  });

  it('names the step rate, the muscles and the passive joints, each with which way it was', () => {
    expect(restoreMismatch({ ...RUN, dt: 1 / 2000 }, RUN)).toMatch(
      /^This session was saved at 2000 steps a second and this run steps at 1000; its settings/,
    );
    expect(restoreMismatch(RUN, { ...RUN, channels: channels.slice(0, 1) })).toMatch(
      /^This session was saved with muscles on and this run has them off;/,
    );
    expect(restoreMismatch({ ...RUN, modules: RUN.modules.slice(0, 1) }, RUN)).toMatch(
      /^This session was saved with passive joint resistance off and this run has it on;/,
    );
  });

  it('calls any other difference another build of the body', () => {
    const bigger: ChannelPrint[] = [['body.pose', '1.0.0', 4104], channels[1] as ChannelPrint];
    expect(restoreMismatch({ ...RUN, channels: bigger }, RUN)).toBe(RESTORE_REFUSED);
    const newer: ChannelPrint[] = [['body.pose', '2.0.0', 4096], channels[1] as ChannelPrint];
    expect(restoreMismatch({ ...RUN, channels: newer }, RUN)).toBe(RESTORE_REFUSED);
    expect(
      restoreMismatch({ ...RUN, modules: [...RUN.modules, 'bsums.xyz.bs-humany.elsewhere'] }, RUN),
    ).toBe(RESTORE_REFUSED);
    expect(RESTORE_REFUSED).toMatch(/restarted from the beginning\.$/);
  });
});

describe('a session saved from a run', () => {
  it('goes back into a fresh run built from its own settings, at its rate, with its muscles', async () => {
    const document = buildDocument();
    const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
    const options = {
      profileId: 'l1_standard',
      backend: 'mujoco' as const,
      passiveJoints: true,
      redistribute: true,
      dropHeight: 0.2,
      groundHeight: 0,
    };
    // Saved from a run at a rate no profile has, with muscles: the two a fresh studio got wrong.
    const saved = new Simulation(document, morphology, {
      ...options,
      muscles: true,
      stepsPerSecond: 760,
    });
    await saved.start();
    for (let t = 0; t < 40; t++) saved.tick();
    const text = JSON.stringify({
      format: SESSION_FORMAT,
      savedAt: '2026-09-27T09:00:00.000Z',
      settings: { ...FIRST_FORMAT.settings, dropHeight: 0.2 },
      simulation: {
        ticks: saved.ticks,
        snapshot: serializeSnapshot(saved.snapshot()),
        channels: channelPrints(saved.kernel.channels),
      },
    } satisfies SessionFile);
    const expected = saved.kernel.stateHash();
    saved.dispose();

    // As the studio loads it: the settings from the file, the rate and the muscles from its run.
    const file: unknown = JSON.parse(text);
    if (!isSessionFile(file) || !file.simulation) throw new Error('not a session with a run');
    const snapshot = deserializeSnapshot(file.simulation.snapshot);
    const settings = normaliseSettings(file.settings, snapshot);
    const fresh = new Simulation(document, morphology, {
      ...options,
      passiveJoints: settings.passive,
      muscles: settings.muscles,
      stepsPerSecond: settings.stepsPerSecond,
    });
    await fresh.start();
    const running: RunPrint = {
      dt: fresh.dt,
      channels: channelPrints(fresh.kernel.channels),
      modules: fresh.kernel.order(),
    };
    expect(restoreMismatch(savedRunPrint(snapshot, file.simulation.channels), running)).toBe(
      undefined,
    );
    fresh.restore(snapshot, file.simulation.ticks);
    expect(fresh.kernel.stateHash()).toBe(expected);
    expect(fresh.ticks).toBe(40);

    // And the same file read without its fingerprint, as a file of the first format is.
    expect(restoreMismatch(savedRunPrint(snapshot, undefined), running)).toBeUndefined();
    fresh.dispose();
  }, 60_000);
});
