/**
 * Scenario runner -- the shared substrate of the plausibility suite (13.4), the goldens (13.2)
 * and the benchmarks (M3.19).
 *
 * Builds the articulation, places it as the scenario asks, assembles a kernel with the physics,
 * passive-joint, grab and metrics modules on the given backend, and samples the channels at a
 * fixed cadence into plain arrays. The sample stream is what every consumer looks at; none of
 * them touches a backend.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import {
  type CompiledArticulation,
  type IPhysicsBackend,
  ROOT_NQ,
  ROOT_NV,
  compileArticulation,
} from '@bs-humany/compiler';
import { type Vec3, rotate, vec3 } from '@bs-humany/frames';
import type { HsdlDocument } from '@bs-humany/hsdl';
import { Kernel } from '@bs-humany/kernel';
import {
  BODY_JOINT_STATE,
  BODY_POSE,
  BODY_VELOCITY,
  CONTACT_MANIFOLDS,
  CouplingModule,
  DIAGNOSTICS_ENERGY,
  DIAGNOSTICS_LIMITS,
  GrabModule,
  MetricsModule,
  PassiveJointModule,
  PhysicsModule,
} from '@bs-humany/modules-mechanics';
import {
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { ALL_MUSCLES } from '@bs-humany/muscle-data';
import {
  type Scenario,
  createScenarioApi,
  placeArticulation,
  profileRateHz,
} from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';

export interface Sample {
  readonly tick: number;
  readonly time: number;
  /** 3N */
  readonly position: Float64Array;
  /** 4N */
  readonly orientation: Float64Array;
  /** nq */
  readonly q: Float64Array;
  readonly kinetic: number;
  readonly potential: number;
  readonly drift: number;
  readonly contacts: number;
  readonly maxPenetration: number;
  /** Largest range violation across DoFs, radians. */
  readonly maxViolation: number;
  /** Work done so far by emulated couplings, joules; zero where the backend solves them. */
  readonly couplingWork: number;
  /** Whole-body centre of mass. */
  readonly com: Vec3;
  readonly linearMomentum: Vec3;
}

export interface Trajectory {
  readonly scenarioId: string;
  readonly backend: string;
  readonly profileId: string;
  readonly dt: number;
  readonly ticks: number;
  readonly samples: readonly Sample[];
  readonly articulation: CompiledArticulation;
  /** Wall-clock milliseconds spent stepping. */
  readonly stepMs: number;
}

export interface RunOptions {
  readonly sampleEveryTicks?: number | undefined;
  readonly document?: HsdlDocument | undefined;
  /**
   * Run the kernel's declared-access audit. Off unless asked for, even inside a test run where the
   * environment would turn it on: see `runScenario`.
   */
  readonly audit?: boolean | undefined;
  /** Stop after this many ticks, if that is sooner than the scenario's own duration. */
  readonly maxTicks?: number | undefined;
  /**
   * Wall-clock milliseconds the stepping may take before the run gives up with an error naming
   * the scenario and how far it got. The stepping loop is synchronous, so a test runner's timeout
   * cannot fire inside it: a solve that slowed to a crawl would otherwise hold its test, and
   * everything waiting on it, for as long as it took. Checked at each sample, so it costs nothing
   * per tick and never changes a trajectory; unbounded when absent.
   */
  readonly budgetMs?: number | undefined;
}

export async function runScenario(
  backend: IPhysicsBackend,
  scenario: Scenario,
  options: RunOptions = {},
): Promise<Trajectory> {
  const document = options.document ?? buildDocument();
  const profile = document.segmentation.find((p) => p.id === scenario.profileId);
  if (!profile) throw new Error(`No profile '${scenario.profileId}'.`);
  const morphology = resolveMorphology(scenario.morphology);
  const compiled = compileArticulation(document, scenario.profileId, morphology).articulation;
  const articulation = placeArticulation(
    compiled,
    scenario.rootRotation,
    scenario.clearance,
    scenario.ground.height,
  );
  const rate = profileRateHz(profile);
  const dt = 1 / rate;
  // The audit is passed explicitly rather than left to the environment, which turns it on for
  // every test run. A golden is up to ten seconds of a whole body at up to a kilohertz, and
  // checking every channel after every module's step for all of it would slow the suite's longest
  // file for nothing the golden checks; the audit reads and never writes, so it cannot change a
  // trajectory either way. The scenarios are audited instead by a short second pass over each
  // (goldenSuite.ts), which asks for it here.
  const kernel = new Kernel({
    rateHz: rate,
    seed: 1,
    preferShared: false,
    audit: options.audit ?? false,
  });
  const physics = new PhysicsModule(backend, articulation, {
    ground: scenario.ground,
    iterations: profile.solver?.iterations,
    staticBoxes: scenario.staticBoxes,
  });
  const grab = new GrabModule(backend, articulation);
  const metrics = new MetricsModule(articulation);
  kernel.register(physics);
  kernel.register(grab);
  kernel.register(metrics);
  const coupling = new CouplingModule(articulation, backend.capabilities);
  kernel.register(coupling);
  if (scenario.passiveJoints) kernel.register(new PassiveJointModule(articulation));

  // Muscles, when the scenario asks for them: the tilting floor carries the whole set, slack, so
  // its plausibility check and its declared-access audit cover the muscle modules under a moving
  // floor. Nothing here drives them. The scenarios that did -- a script's excitations, a policy
  // of their own -- were deleted on 2026-09-28, and with no slider to move it the drive stays at
  // the zero it is built with.
  if (scenario.muscles) {
    const muscles = compileMuscleSet(
      [...ALL_MUSCLES],
      document.attachmentSites,
      articulation,
      morphology.context,
      document.wrappingSurfaces ?? [],
    );
    kernel.register(
      new MuscleTestDriveModule(muscles, [
        { units: 'all', pattern: { kind: 'constant', level: 0 } },
      ]),
    );
    kernel.register(new MusclePathModule(articulation, muscles));
    kernel.register(new MuscleDynamicsModule(articulation, muscles));
  }
  await kernel.init();

  const pose = kernel.channels.storage(BODY_POSE).fields;
  const velocity = kernel.channels.storage(BODY_VELOCITY).fields;
  const joint = kernel.channels.storage(BODY_JOINT_STATE).fields;
  const energy = kernel.channels.storage(DIAGNOSTICS_ENERGY).fields;
  const limits = kernel.channels.storage(DIAGNOSTICS_LIMITS).fields;
  const contacts = kernel.channels.storage(CONTACT_MANIFOLDS);
  const position = pose.position as Float64Array;
  const orientation = pose.orientation as Float64Array;
  // Every move goes straight to the solver, with no copy of the scenery to keep and no move
  // skipped: the goldens record what the solver did, and nothing here draws the boxes.
  const api = createScenarioApi({
    segmentIds: articulation.segments.map((s) => s.id),
    position,
    grab,
    moveStaticBox: (id, at, rotation) => physics.setStaticBoxTransform(id, at, rotation),
  });

  const every = Math.max(1, options.sampleEveryTicks ?? Math.round(rate / 50));
  const full = Math.round(scenario.durationSeconds * rate);
  const ticks = options.maxTicks === undefined ? full : Math.min(full, options.maxTicks);
  const samples: Sample[] = [];
  const sample = (tick: number) => {
    const depth = contacts.fields.depth as Float64Array;
    let maxPenetration = 0;
    for (let i = 0; i < contacts.count; i++)
      maxPenetration = Math.max(maxPenetration, depth[i] ?? 0);
    const margin = limits.margin as Float64Array;
    let maxViolation = 0;
    for (let i = 0; i < margin.length; i++)
      maxViolation = Math.max(maxViolation, -(margin[i] ?? 0));
    let cx = 0;
    let cy = 0;
    let cz = 0;
    articulation.segments.forEach((s, i) => {
      const c = rotate(
        {
          x: orientation[4 * i] ?? 0,
          y: orientation[4 * i + 1] ?? 0,
          z: orientation[4 * i + 2] ?? 0,
          w: orientation[4 * i + 3] ?? 1,
        },
        s.com,
      );
      cx += (s.mass * ((position[3 * i] ?? 0) + c.x)) / articulation.totalMass;
      cy += (s.mass * ((position[3 * i + 1] ?? 0) + c.y)) / articulation.totalMass;
      cz += (s.mass * ((position[3 * i + 2] ?? 0) + c.z)) / articulation.totalMass;
    });
    const lm = energy.linearMomentum as Float64Array;
    samples.push({
      tick,
      time: tick * dt,
      position: Float64Array.from(position),
      orientation: Float64Array.from(orientation),
      q: Float64Array.from(joint.q as Float64Array),
      kinetic: (energy.kinetic as Float64Array)[0] ?? 0,
      potential: (energy.potential as Float64Array)[0] ?? 0,
      drift: (energy.drift as Float64Array)[0] ?? 0,
      contacts: physics.contactsSeen,
      maxPenetration,
      maxViolation,
      couplingWork: coupling.work,
      com: vec3(cx, cy, cz),
      linearMomentum: vec3(lm[0] ?? 0, lm[1] ?? 0, lm[2] ?? 0),
    });
  };

  void velocity;
  sample(0);
  const started = performance.now();
  let stepMs = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    scenario.script?.((tick - 1) * dt, api);
    const t0 = performance.now();
    kernel.step();
    stepMs += performance.now() - t0;
    if (tick % every === 0 || tick === ticks) {
      sample(tick);
      const spent = performance.now() - started;
      if (options.budgetMs !== undefined && spent > options.budgetMs) {
        kernel.dispose();
        throw new Error(
          `Scenario '${scenario.id}' on ${backend.id} used its ${Math.round(options.budgetMs / 1000)} s ` +
            `wall-clock budget by tick ${tick} of ${ticks}: the stepping has slowed to a crawl or ` +
            'the machine is badly overloaded, and waiting longer would only hold up the run.',
        );
      }
    }
  }
  kernel.dispose();
  return {
    scenarioId: scenario.id,
    backend: backend.id,
    profileId: scenario.profileId,
    dt,
    ticks,
    samples,
    articulation,
    stepMs,
  };
}

export { ROOT_NQ, ROOT_NV };
