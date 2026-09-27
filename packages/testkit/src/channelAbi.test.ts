/**
 * The channel ABI table: every channel the body can publish, with its version and a hash of its
 * layout, checked against `goldens/channel-abi.json`.
 *
 * A channel's version is the promise a reader is written against (`ChannelRef.version`), and the
 * kernel refuses a module whose range the channel does not satisfy. That promise is only worth
 * something if the version moves when the layout does, and nothing made it: every channel has
 * been 1.0.0 since it was written, and `muscle.polyline` gained its `body` field (N3.4) without a
 * bump. This test is what makes it move. It builds the fullest body there is -- the L3 profile
 * with every module that gives a channel, and the cord, the nerves and the motor noise besides,
 * so their declared reads are checked against the same channels -- and hashes each channel's
 * shape. A shape that changes under the same version fails, and so does a channel that appears
 * or disappears without the table being updated.
 *
 * The hash covers what a reader's code depends on: the id, the layout, the mode, and each field's
 * name, dtype and component count, in order, since the order is the order of the buffers. It
 * leaves out the element count and capacity, which follow the model (a profile with more
 * segments has more poses) rather than the contract, and the backing, which says where the bytes
 * live, not what they mean.
 *
 * `UPDATE_GOLDENS=1 pnpm vitest run packages/testkit/src/channelAbi.test.ts` rewrites the table,
 * the way `pnpm goldens:update` rewrites the trajectories. It will not record a new shape under
 * an old version: bump the channel's version first (the module-authoring guide says which part),
 * then update, and commit the table with the reason.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { type ChannelSpec, Kernel } from '@bs-humany/kernel';
import {
  CouplingModule,
  GrabModule,
  MetricsModule,
  PassiveJointModule,
  PhysicsModule,
  SkeletonPoseModule,
} from '@bs-humany/modules-mechanics';
import {
  MuscleDynamicsModule,
  MuscleMomentModule,
  MusclePathModule,
  MuscleTestDriveModule,
  MuscleVolumeModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { MlpPolicy, MotorNoiseModule, NervesModule, SpinalModule } from '@bs-humany/modules-nerves';
import { VestibularModule } from '@bs-humany/modules-sensing';
import { ALL_MUSCLES } from '@bs-humany/muscle-data';
import {
  GOAL_SIZE,
  driveOutputs,
  placeArticulation,
  profileRateHz,
  reflexGroups,
} from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { updatingGoldens } from './goldenSuite.js';

const TABLE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'goldens',
  'channel-abi.json',
);

interface AbiEntry {
  readonly version: string;
  readonly hash: string;
}
type AbiTable = Record<string, AbiEntry>;

/** The profile every other one is derived from, and the one with the most channels in use. */
const PROFILE = 'l3_anatomical';

/** Compiling the whole muscled body and initialising MuJoCo with it takes a few seconds. */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * A channel's shape as text, then hashed. JSON of arrays rather than of the spec itself, so the
 * text does not depend on the order a spec happens to list its keys in, only on the field order,
 * which is part of the contract.
 */
function abiHash(spec: ChannelSpec): string {
  const shape = JSON.stringify([
    spec.id,
    spec.layout,
    spec.mode,
    spec.fields.map((f) => [f.name, f.dtype, f.components]),
  ]);
  return createHash('sha256').update(shape).digest('hex').slice(0, 16);
}

/** Every channel the fullest body gives, by id, as the kernel holds it after init. */
async function channelsOfTheWholeBody(): Promise<Map<string, ChannelSpec>> {
  const document = buildDocument();
  const profile = document.segmentation.find((p) => p.id === PROFILE);
  if (!profile) throw new Error(`No profile '${PROFILE}'.`);
  const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
  const compiled = compileArticulation(document, PROFILE, morphology).articulation;
  const articulation = placeArticulation(compiled, undefined, 0.05, 0);
  const rate = profileRateHz(profile);
  const backend = new MujocoBackend();
  const muscles = compileMuscleSet(
    [...ALL_MUSCLES],
    document.attachmentSites,
    articulation,
    morphology.context,
    document.wrappingSurfaces ?? [],
  );
  const outputs = driveOutputs();

  // Nothing is stepped, so the audit would only cost a copy of every channel at init.
  const kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false, audit: false });
  kernel.register(new PhysicsModule(backend, articulation, { ground: { height: 0 } }));
  kernel.register(new SkeletonPoseModule(document.bones, articulation));
  kernel.register(new GrabModule(backend, articulation));
  kernel.register(new MetricsModule(articulation));
  kernel.register(new CouplingModule(articulation, backend.capabilities));
  kernel.register(new PassiveJointModule(articulation));
  kernel.register(new VestibularModule(articulation));
  kernel.register(
    new MuscleTestDriveModule(muscles, [{ units: 'all', pattern: { kind: 'constant', level: 0 } }]),
  );
  kernel.register(new MusclePathModule(articulation, muscles));
  kernel.register(new MuscleDynamicsModule(articulation, muscles));
  kernel.register(new MuscleMomentModule(articulation, muscles));
  kernel.register(new MuscleVolumeModule(articulation, muscles, { simulationRateHz: rate }));
  kernel.register(
    new SpinalModule(muscles, {
      groups: reflexGroups(),
      gains: { stretch: 0, velocity: 0 },
      stepSeconds: 1 / rate,
    }),
  );
  const goal = new Float64Array(GOAL_SIZE);
  kernel.register(
    new NervesModule(articulation, muscles, {
      policy: (inputs, count) => new MlpPolicy([inputs, 8, count]),
      outputs,
      goalSize: GOAL_SIZE,
      goal: () => goal,
      controlDivisor: 1,
      authority: 0,
    }),
  );
  kernel.register(new MotorNoiseModule(muscles, { outputs, level: 0 }));
  await kernel.init();

  const specs = new Map<string, ChannelSpec>();
  for (const id of kernel.channels.ids().sort()) specs.set(id, kernel.channels.storage(id).spec);
  return specs;
}

function readTable(): AbiTable {
  return existsSync(TABLE_FILE) ? (JSON.parse(readFileSync(TABLE_FILE, 'utf8')) as AbiTable) : {};
}

function formatTable(table: AbiTable): string {
  const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

const UPDATE_HOW =
  '`UPDATE_GOLDENS=1 pnpm vitest run packages/testkit/src/channelAbi.test.ts`, and commit ' +
  'channel-abi.json with the reason';

/**
 * What is wrong with one channel against its recorded entry, or nothing. A new shape under an
 * old version is named first and on its own, because updating the table does not fix it: the
 * version has to move, or every reader written against it is reading a layout it never saw.
 */
function problem(id: string, now: AbiEntry, recorded: AbiEntry | undefined): string | undefined {
  if (!recorded) {
    return `channel '${id}' is not in the ABI table. Give its version a meaning (see "Channel versions" in docs/guides/module-authoring.md), then run ${UPDATE_HOW}.`;
  }
  if (now.hash !== recorded.hash && now.version === recorded.version) {
    return (
      `channel '${id}' changed its layout but is still version ${now.version}. Bump the minor ` +
      'version for an added field, the major for a changed meaning, unit or dtype, then run ' +
      `${UPDATE_HOW}.`
    );
  }
  if (now.hash !== recorded.hash || now.version !== recorded.version) {
    return (
      `channel '${id}' is now version ${now.version} (hash ${now.hash}) and the table says ` +
      `${recorded.version} (hash ${recorded.hash}). Run ${UPDATE_HOW}.`
    );
  }
  return undefined;
}

describe('the channel ABI table', () => {
  it(
    'records every channel the body gives, and no channel changes shape under the same version',
    async () => {
      const specs = await channelsOfTheWholeBody();
      const now: AbiTable = {};
      for (const [id, spec] of specs) now[id] = { version: spec.version, hash: abiHash(spec) };
      const recorded = readTable();

      const problems: string[] = [];
      for (const [id, entry] of Object.entries(now)) {
        const p = problem(id, entry, recorded[id]);
        if (p) problems.push(p);
      }
      for (const id of Object.keys(recorded)) {
        if (!(id in now)) {
          problems.push(
            `channel '${id}' is in the ABI table but nothing gives it any more. If it was ` +
              `removed on purpose, run ${UPDATE_HOW}.`,
          );
        }
      }

      if (updatingGoldens()) {
        // Update mode rewrites everything except a layout change that kept its version, which
        // is the one thing this table exists to stop and which no update can make right.
        const unbumped = problems.filter((p) => p.includes('is still version'));
        expect(unbumped, unbumped.join('\n')).toEqual([]);
        const text = formatTable(now);
        const current = existsSync(TABLE_FILE) ? readFileSync(TABLE_FILE, 'utf8') : '';
        if (text !== current) writeFileSync(TABLE_FILE, text);
        console.log(
          `channel ABI table: ${problems.length === 0 ? 'unchanged' : problems.join('\n')}`,
        );
        return;
      }
      expect(problems, problems.join('\n')).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );

  it('hashes the shape, not the size', () => {
    const spec: ChannelSpec = {
      id: 'test.abi',
      version: '1.0.0',
      layout: 'SoA',
      fields: [
        { name: 'a', dtype: 'f64', components: 3 },
        { name: 'b', dtype: 'u8', components: 1 },
      ],
      elementCount: 4,
      mode: 'single-writer',
      backing: 'shared',
    };
    const same = abiHash(spec);
    // The element count, the capacity and the backing follow the model and the host.
    expect(abiHash({ ...spec, elementCount: 40, backing: 'local' })).toBe(same);
    expect(abiHash({ ...spec, elementCount: 'dynamic', capacity: 8 })).toBe(same);
    // The version is recorded beside the hash, not in it, so a bump alone moves only the version.
    expect(abiHash({ ...spec, version: '1.1.0' })).toBe(same);
    // Everything a reader's code depends on moves it.
    const moved = [
      { ...spec, id: 'test.other' },
      { ...spec, mode: 'accumulator' as const },
      { ...spec, fields: [...spec.fields, { name: 'c', dtype: 'f32' as const, components: 1 }] },
      { ...spec, fields: [spec.fields[1], spec.fields[0]] as ChannelSpec['fields'] },
      { ...spec, fields: [{ ...spec.fields[0], dtype: 'f32' as const }, spec.fields[1]] },
      { ...spec, fields: [{ ...spec.fields[0], components: 4 }, spec.fields[1]] },
      { ...spec, fields: [{ ...spec.fields[0], name: 'z' }, spec.fields[1]] },
    ] as ChannelSpec[];
    for (const m of moved) expect(abiHash(m)).not.toBe(same);
  });
});
