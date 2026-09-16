/**
 * Scenario runner -- the shared substrate of the conformance harness (13.3), the plausibility
 * suite (13.4), the goldens (13.2) and the benchmarks (M3.19).
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
import { ELBOW_MUSCLES, KNEE_MUSCLES, SHOULDER_MUSCLES } from '@bs-humany/muscle-data';
import { type Scenario, type ScenarioApi, placeArticulation } from '@bs-humany/scenarios';
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
  const rate = profile.solver?.rate ?? 500;
  const dt = 1 / rate;
  const kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false });
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

  // Muscles, when the scenario asks for them. A scenario that drives muscles and runs without
  // them is not a slower version of itself -- it is a different experiment, and its golden would
  // be a record of a body doing nothing.
  let muscleDrive: MuscleTestDriveModule | undefined;
  if (scenario.muscles) {
    const muscles = compileMuscleSet(
      [...ELBOW_MUSCLES, ...SHOULDER_MUSCLES, ...KNEE_MUSCLES],
      document.attachmentSites,
      articulation,
      morphology.context,
      document.wrappingSurfaces ?? [],
    );
    muscleDrive = new MuscleTestDriveModule(muscles, [
      { units: 'all', pattern: { kind: 'constant', level: 0 } },
    ]);
    kernel.register(muscleDrive);
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
  const segmentIndex = new Map(articulation.segments.map((s) => [s.id, s.index]));
  const api: ScenarioApi = {
    segment: (id) => segmentIndex.get(id) ?? -1,
    segmentPosition: (i) =>
      vec3(position[3 * i] ?? 0, position[3 * i + 1] ?? 0, position[3 * i + 2] ?? 0),
    grab: (s, local, target) => grab.grab(s, local, target),
    moveGrab: (target) => grab.moveTo(target),
    release: () => grab.release(),
    drive: (unit, level) => muscleDrive?.setOverride(unit, level),
  };

  const every = Math.max(1, options.sampleEveryTicks ?? Math.round(rate / 50));
  const ticks = Math.round(scenario.durationSeconds * rate);
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
    if (tick % every === 0 || tick === ticks) sample(tick);
  }
  void started;
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
