import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { PassiveJointModule, PhysicsModule } from '@bs-humany/modules-mechanics';
import {
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { ANKLE_MUSCLES, KNEE_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import {
  type BodyDescription,
  SENSE_MEANINGS,
  bodyFingerprint,
  compareBody,
  compareCord,
  senseFamily,
  senseMeaning,
  summariseDifferences,
} from './bodyFingerprint.js';
import { NervesModule } from './nervesModule.js';
import { MlpPolicy, type PolicyFile } from './policy.js';
import { DEFAULT_SPINAL_GAINS } from './spinalModule.js';

/** A body built from scratch: the document, the articulation and the muscles, every time. */
function build(profile = 'l1_standard') {
  const document = buildDocument();
  const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
  const { articulation } = compileArticulation(document, profile, morphology);
  const muscles = compileMuscleSet(
    [...ANKLE_MUSCLES, ...KNEE_MUSCLES],
    document.attachmentSites,
    articulation,
    morphology.context,
    document.wrappingSurfaces ?? [],
  );
  return { articulation, muscles };
}

/** A sense list shaped like the observation's, short enough to read. */
const SENSES = [
  'angle:knee_r:flexion',
  'rate:knee_r:flexion',
  'pelvis.localSpin.x',
  'pelvis.localSpin.y',
  'pelvis.localSpin.z',
  'head.height',
  'foot.left.weight',
  'strain:soleus',
  'goal[0]',
];
const DRIVES = ['soleus', 'tibialis'];

function describeBody(profile = 'l1_standard'): BodyDescription {
  const { articulation, muscles } = build(profile);
  return {
    profile: articulation.profileId,
    dtSeconds: 1 / 500,
    controlDivisor: 5,
    senses: SENSES,
    drives: DRIVES,
    muscles: muscles.units,
    cord: DEFAULT_SPINAL_GAINS,
  };
}

describe('bodyFingerprint', () => {
  it('is the same for two builds of the same body', () => {
    const a = bodyFingerprint(describeBody());
    const b = bodyFingerprint(describeBody());
    expect(b).toEqual(a);
    expect(compareBody(a, b)).toEqual([]);
    // It survives the trip through a checkpoint file, which is JSON.
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    // Every sense is at meaning 1 today, so none is listed.
    expect(a.senses.meanings).toEqual({});
    expect(a.senses.count).toBe(SENSES.length);
    expect(a.muscles.count).toBe(build().muscles.units.length);
  });

  it('does not care what order the senses and drives arrive in', () => {
    const body = describeBody();
    const a = bodyFingerprint(body);
    const b = bodyFingerprint({
      ...body,
      senses: [...body.senses].reverse(),
      drives: [...body.drives].reverse(),
    });
    expect(b).toEqual(a);
  });

  it('changes when a sense meaning, the profile, the step or a muscle parameter does', () => {
    const body = describeBody();
    const base = bodyFingerprint(body);

    // A sense fix bumps its family in the table; the schema changes and the names do not.
    const bumped = bodyFingerprint(body, { ...SENSE_MEANINGS, 'pelvis.localSpin': 2 });
    expect(bumped.senses.schema).not.toBe(base.senses.schema);
    expect(bumped.senses.names).toBe(base.senses.names);
    expect(bumped.senses.meanings).toEqual({
      'pelvis.localSpin.x': 2,
      'pelvis.localSpin.y': 2,
      'pelvis.localSpin.z': 2,
    });

    expect(bodyFingerprint({ ...body, profile: 'l3_anatomical' }).profile).toBe('l3_anatomical');
    expect(compareBody(base, bodyFingerprint({ ...body, dtSeconds: 1 / 1000 }))).toEqual([
      '500 steps a second then, 1000 now',
    ]);

    // One unit's force, a tenth of a percent: the kind of change a data fix makes.
    const units = body.muscles.map((u, i) =>
      i === 0
        ? {
            ...u,
            parameters: {
              ...u.parameters,
              maxIsometricForce: u.parameters.maxIsometricForce * 1.001,
            },
          }
        : u,
    );
    const stronger = bodyFingerprint({ ...body, muscles: units });
    expect(stronger.muscles.hash).not.toBe(base.muscles.hash);
    expect(compareBody(base, stronger)).toEqual([
      `muscle parameters differ (${units.length} units either way)`,
    ]);
  });

  it('names the senses whose meaning changed, and only the ones the checkpoint had', () => {
    const body = describeBody();
    const saved = bodyFingerprint(body);
    const current = bodyFingerprint(body, {
      ...SENSE_MEANINGS,
      'pelvis.localSpin': 2,
      'angle:knee_r:flexion': 3,
    });
    const differences = compareBody(saved, current, SENSES);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain('angle:knee_r:flexion (1 then, 3 now)');
    expect(differences[0]).toContain('pelvis.localSpin.x (1 then, 2 now)');
    expect(differences[0]).toContain('pelvis.localSpin.z (1 then, 2 now)');
    expect(differences[0]).not.toContain('rate:');

    // A sense the checkpoint never had is new, not changed: the fit starts it at zero and says so.
    const without = compareBody(
      saved,
      current,
      SENSES.filter((s) => s !== 'angle:knee_r:flexion'),
    );
    expect(without[0]).not.toContain('angle:knee_r:flexion');
    expect(without[0]).toContain('pelvis.localSpin.y');
  });

  it('says every other difference in a sentence of its own', () => {
    const body = describeBody();
    const saved = bodyFingerprint(body);
    const current = bodyFingerprint({
      ...body,
      profile: 'l3_anatomical',
      controlDivisor: 10,
      senses: [...body.senses, 'head.height.extra'],
      drives: ['soleus', 'gastrocnemius'],
      cord: { ...DEFAULT_SPINAL_GAINS, stretch: 0.05 },
    });
    expect(compareBody(saved, current)).toEqual([
      'profile l1_standard then, l3_anatomical now',
      'the policy ran every 5 ticks then, every 10 now',
      `${SENSES.length} senses then, ${SENSES.length + 1} now`,
      'drives renamed (2 either way)',
      'cord: stretch 0 then, 0.05 now',
    ]);
    expect(compareCord(DEFAULT_SPINAL_GAINS, DEFAULT_SPINAL_GAINS)).toBeUndefined();
    // A fingerprint from another version is not read field by field.
    expect(compareBody({ ...saved, version: 2 }, current)).toHaveLength(1);
  });

  it('compares a cord by region as the body answers with it', () => {
    // A policy saved over one stretch everywhere, against a cord that differs by region: the
    // regions that moved, and nothing for the ones that did not.
    const one = { ...DEFAULT_SPINAL_GAINS, stretch: 8.5 };
    const byRegion = { ...one, regionStretch: { Arm: 2, Leg: 8.5 } };
    expect(compareCord(one, byRegion)).toBe('cord: arm stretch 8.5 then, 2 now');
    // The same stretch named in every region is the same cord.
    const everywhere = {
      ...one,
      regionStretch: { Arm: 8.5, Hand: 8.5, Leg: 8.5, Trunk: 8.5, Neck: 8.5 },
    };
    expect(compareCord(one, everywhere)).toBeUndefined();
  });

  it('shortens a long list for a panel', () => {
    expect(summariseDifferences(['a', 'b'])).toBe('a; b');
    expect(summariseDifferences(['a', 'b', 'c', 'd'])).toBe('a; b; and 2 more');
  });

  it('reads a sense by its own entry, then its family', () => {
    expect(senseFamily('angle:knee_r:flexion')).toBe('angle');
    expect(senseFamily('pelvis.localVelocity.z')).toBe('pelvis.localVelocity');
    expect(senseFamily('goal[3]')).toBe('goal');
    expect(senseFamily('context[12]')).toBe('context');
    expect(senseFamily('foot.right.contacts')).toBe('foot.right.contacts');
    expect(senseMeaning('rate:hip_l:flexion', { rate: 2 })).toBe(2);
    expect(senseMeaning('rate:hip_l:flexion', { rate: 2, 'rate:hip_l:flexion': 4 })).toBe(4);
    expect(senseMeaning('unheard.of')).toBe(1);
  });
});

describe('NervesModule and the body a policy was trained in', () => {
  const outputs = [
    { id: 'soleus', units: [{ id: 'soleus_r', weight: 1 }] },
    { id: 'tibialis', units: [{ id: 'tibialis_anterior_r', weight: 1 }] },
  ];

  /** A body with nerves in it, initialised, holding `policy` or a fresh one. */
  async function body(policy?: PolicyFile) {
    const { articulation, muscles } = build();
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    kernel.register(
      new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }),
    );
    kernel.register(new PassiveJointModule(articulation));
    kernel.register(
      new MuscleTestDriveModule(muscles, [
        { units: 'all', pattern: { kind: 'constant', level: 0 } },
      ]),
    );
    kernel.register(new MusclePathModule(articulation, muscles));
    kernel.register(new MuscleDynamicsModule(articulation, muscles));
    const nerves = new NervesModule(articulation, muscles, {
      policy: policy ?? ((inputs, outs) => new MlpPolicy([inputs, 3, outs])),
      outputs,
      goalSize: 1,
      controlDivisor: 5,
    });
    kernel.register(nerves);
    await kernel.init();
    return { kernel, nerves };
  }

  it('reports the differences on adopt, never refuses, and says when none were recorded', async () => {
    const { kernel, nerves } = await body();
    const here = nerves.bodyFingerprint();
    expect(here.profile).toBe('l1_standard');
    expect(here.dtSeconds).toBeCloseTo(1 / 500, 12);
    expect(here.controlDivisor).toBe(5);
    expect(here.cord).toBeUndefined();
    expect(nerves.bodyFingerprint(DEFAULT_SPINAL_GAINS).cord).toEqual(DEFAULT_SPINAL_GAINS);
    expect(nerves.bodyFingerprint()).toEqual(here);

    const names = nerves.policyNames;
    const policy = new MlpPolicy([names.inputs.length, 3, names.outputs.length]);
    const file = policy.toFile({ task: 't', inputs: names.inputs, outputs: names.outputs });

    // A file from before fingerprints: loads, fits, and says it recorded no body.
    expect(nerves.adopt(file).inputs).toBe(names.inputs.length);
    expect(nerves.carried?.body).toEqual({ recorded: false });
    expect(nerves.trainedBody).toEqual({ recorded: false });

    // Its own body: recorded, nothing different.
    nerves.adopt({ ...file, body: here });
    expect(nerves.trainedBody).toEqual({ recorded: true, differences: [] });

    // Trained on another profile: said, and the policy is still the one in charge.
    nerves.adopt({ ...file, body: { ...here, profile: 'l3_anatomical' } });
    expect(nerves.trainedBody).toEqual({
      recorded: true,
      differences: ['profile l3_anatomical then, l1_standard now'],
    });

    // Trained when its knee angle meant something else: that sense, by name.
    const knee = names.inputs.find((n) => n.startsWith('angle:knee_r')) as string;
    nerves.adopt({
      ...file,
      body: { ...here, senses: { ...here.senses, schema: 'older', meanings: { [knee]: 2 } } },
    });
    const meant = nerves.trainedBody;
    expect(meant?.recorded && meant.differences.join(' ')).toContain(`${knee} (2 then, 1 now)`);
    kernel.run(10);
    expect(nerves.evaluationsSoFar).toBeGreaterThan(0);

    // Released, there is no policy file and so nothing to say.
    nerves.release();
    expect(nerves.trainedBody).toBeUndefined();
  });

  it('compares a file given at construction as it binds', async () => {
    const { nerves: first } = await body();
    const names = first.policyNames;
    const file = new MlpPolicy([names.inputs.length, 3, names.outputs.length]).toFile({
      task: 't',
      inputs: names.inputs,
      outputs: names.outputs,
      body: { ...first.bodyFingerprint(), controlDivisor: 10 },
    });
    const { nerves } = await body(file);
    expect(nerves.trainedBody).toEqual({
      recorded: true,
      differences: ['the policy ran every 10 ticks then, every 5 now'],
    });
  });
});
