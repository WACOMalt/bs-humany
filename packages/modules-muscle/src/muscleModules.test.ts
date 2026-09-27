import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { ROOT_NQ, allocateBuffers, compileArticulation } from '@bs-humany/compiler';
import {
  Kernel,
  type ModuleInitContext,
  type ModuleManifest,
  type SimModule,
} from '@bs-humany/kernel';
import { ACTUATION_BODY_WRENCH, BODY_POSE, PhysicsModule } from '@bs-humany/modules-mechanics';
import { ELBOW_MUSCLES } from '@bs-humany/muscle-data';
import { DIFFERENCE_STEP, momentArmByDifference } from '@bs-humany/muscle-path';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_MOMENT_ARM,
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_CHANNEL_VERSION,
  MUSCLE_CONTACT,
  MUSCLE_EQUILIBRIUM_FAILED,
  MUSCLE_FIBER_OUT_OF_RANGE,
  MUSCLE_PATH,
  MUSCLE_POLYLINE,
  MUSCLE_STATE,
  musclePathSpec,
  musclePolylineSpec,
} from './channels.js';
import { type CompiledMuscleSet, compileMuscleSet } from './compile.js';
import { coordinateIndex, degreeRange, sweepMomentArms } from './momentArmSweep.js';
import { MuscleDynamicsModule } from './muscleDynamicsModule.js';
import { MuscleMomentModule } from './muscleMomentModule.js';
import { MUSCLE_PATH_MODULE_ID, MusclePathModule } from './musclePathModule.js';
import { type DrivePattern, MuscleTestDriveModule } from './muscleTestDriveModule.js';
import { DEFAULT_UPDATE_HZ, MuscleVolumeModule, rateDivisorFor } from './muscleVolumeModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const compiled = compileArticulation(document, 'l3_anatomical', morphology).articulation;
// The elbow is what is under test, and several readings below are taken from wherever the
// unplaced body has landed a few hundred ticks in. The spine's discs change how it lands; the
// body here is compiled without them so those readings keep the landing they were written for.
const articulation = {
  ...compiled,
  constraints: compiled.constraints.filter((c) => c.kind.type !== 'jointHold'),
};
const muscles = compileMuscleSet(
  ELBOW_MUSCLES,
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);
const UNITS = muscles.units.length;
const BICEPS_LONG = muscles.units.findIndex((u) => u.id === 'biceps_brachii_long_r');
/**
 * A unit whose tendon is actually loaded at the neutral pose.
 *
 * Not every one of them is, and that is OQ-015 rather than an accident -- see the test that
 * names the slack ones. Force tests use this one so that they are testing the force path and not
 * re-discovering the same open question in seven different ways.
 */
/**
 * A unit whose tendon is carrying something wherever the arm happens to be.
 *
 * Biceps, not brachioradialis, which is what this was. Brachioradialis has the longest flexion
 * moment arm at the elbow, and a moment arm is an excursion: its path shortens by 98 mm between a
 * straight elbow and a bent one, on 102 mm of fiber, so at full flexion it has nothing left to
 * pull with and its tendon goes slack. A test about whether drive becomes force wants a muscle
 * that is pulling either way.
 */
const LOADED = muscles.units.findIndex((u) => u.id === 'biceps_brachii_long_r');

/**
 * A running body with its elbow muscles wired up.
 *
 * Drive comes from a module rather than from the test writing the buffer, because the kernel
 * zeroes accumulators at the top of every tick -- a writer that stops writing stops contributing,
 * which is the whole point of an accumulator and the reason a nerve module will be able to
 * replace this one by simply being registered instead.
 */
async function session(pattern: DrivePattern = { kind: 'constant', level: 0 }) {
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  kernel.register(new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }));
  const path = new MusclePathModule(articulation, muscles);
  const dynamics = new MuscleDynamicsModule(articulation, muscles);
  const driver = new MuscleTestDriveModule(muscles, [{ units: 'all', pattern }]);
  kernel.register(driver);
  kernel.register(path);
  kernel.register(dynamics);
  await kernel.init();

  const pathFields = kernel.channels.storage(MUSCLE_PATH).fields;
  const stateFields = kernel.channels.storage(MUSCLE_STATE).fields;
  const drive = kernel.channels.storage(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;
  const wrench = kernel.channels.storage(ACTUATION_BODY_WRENCH).fields;
  const pose = kernel.channels.storage(BODY_POSE).fields;
  const f64 = (o: Record<string, unknown>, name: string) => o[name] as Float64Array;

  return {
    kernel,
    path,
    dynamics,
    driver,
    drive,
    length: f64(pathFields, 'length'),
    pathVelocity: f64(pathFields, 'velocity'),
    originBody: pathFields.originBody as Int32Array,
    insertionBody: pathFields.insertionBody as Int32Array,
    originPoint: f64(pathFields, 'originPoint'),
    insertionPoint: f64(pathFields, 'insertionPoint'),
    originDirection: f64(pathFields, 'originDirection'),
    activation: f64(stateFields, 'activation'),
    fiberLength: f64(stateFields, 'fiberLength'),
    tendonForce: f64(stateFields, 'tendonForce'),
    fiberForce: f64(stateFields, 'fiberForce'),
    diagnostic: stateFields.diagnostic as Int32Array,
    wrenchForce: f64(wrench, 'force'),
    wrenchTorque: f64(wrench, 'torque'),
    posePosition: f64(pose, 'position'),
    poseOrientation: f64(pose, 'orientation'),
  };
}

/** A session driven at one level throughout, which is what most of these tests want. */
async function driven(level: number) {
  return session({ kind: 'constant', level });
}

/**
 * Stands in for `MusclePathModule`, publishing whatever length each unit is told to have.
 *
 * The real path module cannot be made to publish a length the skeleton does not allow, and a
 * fiber pushed past its range is exactly what a diagnostic test needs. This takes the path
 * module's id, so the dynamics module's dependency on it resolves, and gives and writes the same
 * two channels. It publishes no polyline points, so the dynamics module computes its force and
 * then has nowhere to push -- the body stays where it is, and only the muscle state is under test.
 */
class HeldLengthPath implements SimModule {
  readonly manifest: ModuleManifest;
  private length: Float64Array | undefined;

  constructor(
    units: number,
    private readonly lengthOf: (unit: number) => number,
  ) {
    this.manifest = {
      id: MUSCLE_PATH_MODULE_ID,
      version: '1.0.0',
      phase: 'actuate',
      dependsOn: [],
      reads: [],
      writes: [
        { id: MUSCLE_PATH, version: MUSCLE_CHANNEL_VERSION },
        { id: MUSCLE_POLYLINE, version: MUSCLE_CHANNEL_VERSION },
      ],
      accumulates: [],
      gives: [musclePathSpec(units), musclePolylineSpec(1)],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.length = ctx.write(MUSCLE_PATH).fields.length as Float64Array;
    ctx.write(MUSCLE_POLYLINE);
  }

  step(): void {
    const length = this.length;
    if (!length) return;
    for (let i = 0; i < length.length; i++) length[i] = this.lengthOf(i);
  }
}

/** The dynamics module alone, on a path held at whatever length each unit is given. */
async function heldAt(set: CompiledMuscleSet, lengthOf: (unit: number) => number, level = 0) {
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  kernel.register(new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }));
  const dynamics = new MuscleDynamicsModule(articulation, set);
  kernel.register(
    new MuscleTestDriveModule(set, [{ units: 'all', pattern: { kind: 'constant', level } }]),
  );
  kernel.register(new HeldLengthPath(set.units.length, lengthOf));
  kernel.register(dynamics);
  await kernel.init();
  const state = kernel.channels.storage(MUSCLE_STATE).fields;
  return {
    kernel,
    dynamics,
    diagnostic: state.diagnostic as Int32Array,
    fiberLength: state.fiberLength as Float64Array,
  };
}

describe('MusclePathModule', () => {
  it('compiles every elbow unit, with nothing it could not represent', async () => {
    const s = await session();
    // The elbow set's wraps are authored and compile cleanly under the geodesic solver: every
    // surface is a sphere or a cylinder, and no span names two. A surface it had to run straight
    // past would be an error here, not a quietly shorter muscle.
    expect(s.path.compileReport.pathCount).toBe(UNITS);
    expect(s.path.compileReport.problems).toEqual([]);
    s.kernel.dispose();
  });

  it('publishes a length no shorter than the straight line between the attachments', async () => {
    // The straight distance is the floor: a path that lies against bone is longer than one that
    // cuts through it, never shorter. This is still the only place the whole chain -- site
    // expression, bone resolution, follower transform, pose, solver -- is checked end to end
    // against a closed form, for the units that clear their surfaces.
    const s = await session();
    // Long enough for the body to fall and the arm to bend. At the rest pose the elbow is
    // extended and every tendon clears its surface, which is correct and makes a poor moment to
    // ask whether wrapping works.
    s.kernel.run(600);
    let wrapped = 0;
    for (let i = 0; i < UNITS; i++) {
      const direct = Math.hypot(
        (s.insertionPoint[3 * i] as number) - (s.originPoint[3 * i] as number),
        (s.insertionPoint[3 * i + 1] as number) - (s.originPoint[3 * i + 1] as number),
        (s.insertionPoint[3 * i + 2] as number) - (s.originPoint[3 * i + 2] as number),
      );
      expect(s.length[i], muscles.units[i]?.id).toBeGreaterThanOrEqual(direct - 1e-12);
      if ((s.length[i] as number) > direct + 1e-9) wrapped++;
      else expect(s.length[i], muscles.units[i]?.id).toBeCloseTo(direct, 12);
    }
    // And at least one really is taking the long way round a bone, or this would be measuring
    // straight lines and calling it wrapping.
    expect(wrapped).toBeGreaterThan(0);
    s.kernel.dispose();
  });

  it('gives every elbow muscle a length in the tens of centimetres', async () => {
    const s = await session();
    s.kernel.run(1);
    for (let i = 0; i < UNITS; i++) {
      expect(s.length[i], muscles.units[i]?.id).toBeGreaterThan(0.05);
      expect(s.length[i], muscles.units[i]?.id).toBeLessThan(0.6);
    }
    s.kernel.dispose();
  });

  it('names bodies that actually hold the attachments', async () => {
    const s = await session();
    s.kernel.run(1);
    for (let i = 0; i < UNITS; i++) {
      const path = muscles.paths[i];
      if (!path) throw new Error('no path');
      expect(s.originBody[i], path.id).toBe(muscles.resolver.bodyOf(path.origin.bone));
      expect(s.insertionBody[i], path.id).toBe(muscles.resolver.bodyOf(path.insertion.bone));
    }
    s.kernel.dispose();
  });

  it('reports the tendons in contact with bone, and clears the rest of the buffer', async () => {
    // Diagnostic only, now that force is applied at every point of the path rather than from
    // this buffer. What it still has to be is well formed: never more contacts than units, and
    // the rest of the buffer marked empty rather than left holding last tick's.
    const s = await session();
    s.kernel.run(600);
    expect(s.path.contactCount).toBeGreaterThanOrEqual(0);
    expect(s.path.contactCount).toBeLessThanOrEqual(UNITS);
    expect(s.path.contactOverflow).toBe(0);
    // Past the live contacts the buffer says so with -1, rather than leaving a stale unit index
    // for section 8.2 to apply last tick's reaction from.
    const unit = s.kernel.channels.storage(MUSCLE_CONTACT).fields.unit as Int32Array;
    expect(unit[s.path.contactCount]).toBe(-1);
    s.kernel.dispose();
  });

  it('follows the body as it moves', async () => {
    const s = await session();
    s.kernel.run(1);
    const before = Array.from(s.length);
    s.kernel.run(400);
    const after = Array.from(s.length);
    // The body falls and settles; at least one elbow muscle's length has to have changed with it.
    expect(after.some((v, i) => Math.abs(v - (before[i] as number)) > 1e-6)).toBe(true);
    s.kernel.dispose();
  });
});

describe('MuscleDynamicsModule', () => {
  it('runs after the path module, so the geometry is this tick’s', async () => {
    const s = await session();
    expect(s.dynamics.manifest.dependsOn[0]?.id).toBe(s.path.manifest.id);
    expect(s.dynamics.manifest.phase).toBe('actuate');
    expect(s.path.manifest.phase).toBe('actuate');
    s.kernel.dispose();
  });

  it('accumulates onto the wrench channel rather than writing it', async () => {
    // Several muscles push on one bone in a tick, and so does everything else that applies a
    // wrench. Declaring it as an accumulator is what lets them coexist; declaring it as a write
    // would make the second muscle module registered a conflict.
    const s = await session();
    expect(s.dynamics.manifest.accumulates.map((c) => c.id)).toEqual([ACTUATION_BODY_WRENCH]);
    expect(s.dynamics.manifest.writes.map((c) => c.id)).toEqual([MUSCLE_STATE]);
    s.kernel.dispose();
  });

  it('starts each fiber in equilibrium, so nothing twitches at t = 0', async () => {
    const s = await session();
    s.kernel.run(1);
    for (let i = 0; i < UNITS; i++) {
      expect(s.fiberLength[i], muscles.units[i]?.id).toBeGreaterThan(0.1);
      expect(s.fiberLength[i], muscles.units[i]?.id).toBeLessThan(2);
      expect((s.diagnostic[i] as number) & MUSCLE_FIBER_OUT_OF_RANGE, muscles.units[i]?.id).toBe(0);
    }
    s.kernel.dispose();
  });

  it('makes almost no force when nobody is driving it', async () => {
    // A relaxed muscle offers only its passive element. That is not nothing: by fifty ticks the
    // body has begun to fall and the arm to move, and a muscle stretched past its optimal length
    // resists being stretched further -- which is what a passive element is for. What would be
    // wrong is a resting muscle pulling like a driven one, so the bound is a fraction of what
    // these units make at full drive rather than a number near zero.
    const s = await session();
    s.kernel.run(50);
    for (let i = 0; i < UNITS; i++) {
      const maximum = muscles.units[i]?.parameters.maxIsometricForce ?? 1;
      expect(s.tendonForce[i], muscles.units[i]?.id).toBeGreaterThanOrEqual(0);
      expect(s.tendonForce[i], muscles.units[i]?.id).toBeLessThan(maximum * 0.25);
    }
    s.kernel.dispose();
  });

  it('turns drive into force, and lags it by the activation time constant', async () => {
    // A step from nothing to full drive, a fifth of a second in.
    const s = await session({ kind: 'step', at: 0.2, before: 0, after: 1 });
    s.kernel.run(100);
    const resting = s.tendonForce[LOADED] as number;
    expect(s.activation[BICEPS_LONG]).toBeLessThan(0.01);

    // One activation time constant after the step is 10 ms, which is 5 ticks at 500 Hz. A first
    // order lag covers 1 - 1/e of the way in one time constant, and that number is the definition
    // of the constant rather than a property of this implementation.
    s.kernel.run(5);
    expect(s.activation[BICEPS_LONG]).toBeCloseTo(1 - Math.exp(-1), 1);

    s.kernel.run(100);
    expect(s.activation[BICEPS_LONG]).toBeGreaterThan(0.95);
    expect(s.tendonForce[LOADED]).toBeGreaterThan(resting + 10);
    s.kernel.dispose();
  });

  it('relaxes more slowly than it contracts', async () => {
    // Thelen's asymmetry, surviving the trip through two channels and a kernel.
    // Full drive, then off after a fifth of a second: how far it falls in 40 ms.
    const falling = await session({ kind: 'step', at: 0.2, before: 1, after: 0 });
    falling.kernel.run(100);
    const peak = falling.activation[BICEPS_LONG] as number;
    falling.kernel.run(20);
    const fell = peak - (falling.activation[BICEPS_LONG] as number);

    // Off, then full drive: how far it climbs in the same 40 ms, over the same interval of the
    // curve, so the two are comparable.
    const rising = await session({ kind: 'step', at: 0.2, before: 0, after: 1 });
    rising.kernel.run(100);
    const rest = rising.activation[BICEPS_LONG] as number;
    rising.kernel.run(20);
    const rose = (rising.activation[BICEPS_LONG] as number) - rest;

    expect(rose).toBeGreaterThan(fell);
    // And by about the ratio of the two constants, which is what makes it Thelen's asymmetry
    // rather than merely an inequality that happens to hold.
    expect(rose / fell).toBeGreaterThan(1.5);
    const s = falling;
    const t = rising;
    s.kernel.dispose();
    t.kernel.dispose();
  });

  // Three whole-body muscle sets, 200 audited ticks each: about 5.5 s on a quiet machine and 8 s
  // under a parallel run, so vitest's 5 s default made it fail on load rather than on tendons.
  it('never lets the tendon push', async () => {
    for (const level of [0, 0.3, 1]) {
      const s = await driven(level);
      s.kernel.run(200);
      for (let i = 0; i < UNITS; i++) {
        expect(s.tendonForce[i], `${muscles.units[i]?.id} at ${level}`).toBeGreaterThanOrEqual(0);
      }
      s.kernel.dispose();
    }
  }, 60_000);

  it('solves every unit every tick, with no fiber leaving its range', async () => {
    // A sine sweep rather than a hold, so every muscle passes through its whole drive range and
    // the fibers are moving rather than sitting at one length.
    const s = await session({ kind: 'sine', mean: 0.5, amplitude: 0.5, frequency: 2 });
    for (let i = 0; i < 12; i++) {
      s.kernel.run(50);
      for (let u = 0; u < UNITS; u++) {
        expect(s.diagnostic[u] as number, muscles.units[u]?.id).toBe(0);
      }
    }
    s.kernel.dispose();
  });

  it('flags a fiber it had to hold at the edge of its range', async () => {
    // A third of its rest length is shorter than any joint can fold a muscle, and too short for
    // its fibers: once the tendon has gone slack there is nothing to stop a driven fiber
    // shortening, the integration asks for one under the muscle model's minimum, and the module
    // holds it there. The flag has to say so. It used to be tested on the length after the hold,
    // which sits on the edge and never past it, so it could not fire at all.
    //
    // The short end rather than the long one because only the short end can be reached: stretched
    // far past its range, a unit's equilibrium settles its fiber a little under the maximum and
    // lets the tendon take the rest.
    const s = await heldAt(muscles, (i) => 0.3 * (muscles.units[i]?.restLength ?? 0), 0.5);
    const flagged = new Set<number>();
    for (let tick = 0; tick < 20; tick++) {
      s.kernel.step();
      for (let u = 0; u < UNITS; u++) {
        if (s.dynamics.isRigid(u)) continue;
        if ((s.diagnostic[u] as number) & MUSCLE_FIBER_OUT_OF_RANGE) flagged.add(u);
        // What is published is still the held length, inside the range.
        expect(s.fiberLength[u], muscles.units[u]?.id).toBeGreaterThanOrEqual(0.1);
      }
    }
    const elastic = muscles.units.filter((_, u) => !s.dynamics.isRigid(u)).length;
    expect(elastic).toBeGreaterThan(0);
    expect(flagged.size).toBe(elastic);
    s.kernel.dispose();
  });

  it('never reports an equilibrium failure for a rigid unit, which has none to find', async () => {
    // Every elbow unit made rigid, by giving it a tendon too short to be worth modelling. Then
    // held at three lengths: its own rest length, one shorter than its tendon, and one far too
    // long. A rigid unit has no equilibrium to search for, so the failure bit is never its to
    // set; a path shorter than its tendon is the fiber out of range, and goes on that bit.
    const rigidSet: CompiledMuscleSet = {
      ...muscles,
      units: muscles.units.map((u) => ({
        ...u,
        parameters: { ...u.parameters, tendonSlackLength: 0.05 * u.parameters.optimalFiberLength },
      })),
    };
    type Unit = CompiledMuscleSet['units'][number];
    const lengths = [
      (u: Unit) => u.restLength,
      (u: Unit) => 0.5 * u.parameters.tendonSlackLength,
      (u: Unit) => 3 * u.restLength,
    ];
    for (const [which, lengthOf] of lengths.entries()) {
      const s = await heldAt(rigidSet, (i) => lengthOf(rigidSet.units[i] as Unit), 0.5);
      for (let u = 0; u < UNITS; u++) expect(s.dynamics.isRigid(u)).toBe(true);
      for (let tick = 0; tick < 20; tick++) {
        s.kernel.step();
        for (let u = 0; u < UNITS; u++) {
          const bits = s.diagnostic[u] as number;
          expect(
            bits & MUSCLE_EQUILIBRIUM_FAILED,
            `${rigidSet.units[u]?.id}, length ${which}`,
          ).toBe(0);
          // Shorter than its tendon: out of range on every tick.
          if (which === 1) {
            expect(bits & MUSCLE_FIBER_OUT_OF_RANGE, `${rigidSet.units[u]?.id}`).toBe(
              MUSCLE_FIBER_OUT_OF_RANGE,
            );
          }
        }
      }
      s.kernel.dispose();
    }
  });

  it('applies forces that sum to zero over the whole system', async () => {
    // Muscle spec 13.4: a muscle pulls its two ends toward each other and pushes on nothing else,
    // so the forces one unit applies must cancel. This is the test that catches a sign error, a
    // missed body, or a direction taken from the wrong end -- none of which would look wrong in
    // a single muscle's force reading.
    const s = await driven(1);
    s.kernel.run(200);
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let b = 0; b < articulation.segments.length; b++) {
      fx += s.wrenchForce[3 * b] as number;
      fy += s.wrenchForce[3 * b + 1] as number;
      fz += s.wrenchForce[3 * b + 2] as number;
    }
    const scale = Math.max(...Array.from(s.tendonForce));
    expect(scale).toBeGreaterThan(50);
    expect(Math.hypot(fx, fy, fz) / scale).toBeLessThan(1e-9);
    s.kernel.dispose();
  });

  it('applies torques that sum to zero about the origin, too', async () => {
    // The stronger half of the same statement, and the one that actually tests the cross product.
    // Total torque about a fixed point is the sum of each body's own torque plus its centre of
    // mass crossed into the force it received. Forces cancelling is not enough: a pair applied at
    // the wrong points would still cancel as forces while leaving a couple behind.
    const s = await driven(1);
    s.kernel.run(200);

    // The wrench accumulator is filled during `actuate`, from the pose the tick starts with, and
    // the physics module overwrites that pose during `solve`. So reading both after a tick would
    // put this tick's forces beside next tick's geometry. Capturing the pose first and then
    // running exactly one more tick lines them up: the wrench that results was computed from
    // precisely these numbers.
    const position = Float64Array.from(s.posePosition);
    const orientation = Float64Array.from(s.poseOrientation);
    s.kernel.run(1);

    let tx = 0;
    let ty = 0;
    let tz = 0;
    for (const segment of articulation.segments) {
      const b = segment.index;
      const fx = s.wrenchForce[3 * b] as number;
      const fy = s.wrenchForce[3 * b + 1] as number;
      const fz = s.wrenchForce[3 * b + 2] as number;
      tx += s.wrenchTorque[3 * b] as number;
      ty += s.wrenchTorque[3 * b + 1] as number;
      tz += s.wrenchTorque[3 * b + 2] as number;

      // Centre of mass in the world, the point that body's torque is taken about.
      const q = orientation.subarray(4 * b, 4 * b + 4);
      const l = segment.com;
      const ax = 2 * ((q[1] as number) * l.z - (q[2] as number) * l.y);
      const ay = 2 * ((q[2] as number) * l.x - (q[0] as number) * l.z);
      const az = 2 * ((q[0] as number) * l.y - (q[1] as number) * l.x);
      const cx =
        (position[3 * b] as number) +
        l.x +
        (q[3] as number) * ax +
        ((q[1] as number) * az - (q[2] as number) * ay);
      const cy =
        (position[3 * b + 1] as number) +
        l.y +
        (q[3] as number) * ay +
        ((q[2] as number) * ax - (q[0] as number) * az);
      const cz =
        (position[3 * b + 2] as number) +
        l.z +
        (q[3] as number) * az +
        ((q[0] as number) * ay - (q[1] as number) * ax);

      tx += cy * fz - cz * fy;
      ty += cz * fx - cx * fz;
      tz += cx * fy - cy * fx;
    }

    const scale = Math.max(...Array.from(s.tendonForce));
    // Normalised by force, so the tolerance reads as a length error rather than a torque one.
    //
    // Not machine zero any more, and the reason is on the record. A wrapped tendon's reaction is
    // distributed along an arc; this applies the resultant at one point on the surface's axis, at
    // the mean height of the two tangent points. That is exact for a sphere, where every normal
    // passes through the centre, and exact for a cylinder wrap that stays in one plane. For a
    // helical wrap the true centre of pressure sits a little off that mean, and the difference
    // shows up here as a residual couple that grows with the helix's pitch. Two nanometres of
    // effective lever arm is what the elbow's wrapping costs; a bug would be orders larger.
    expect(Math.hypot(tx, ty, tz) / scale).toBeLessThan(1e-7);
    s.kernel.dispose();
  });

  it('pulls along its own tendon, not against it', async () => {
    // The sign, stated as what it means: the force on the origin pulls along the tendon, in the
    // direction the tendon actually leaves the origin.
    //
    // Against the straight line to the insertion, which is what this asked before, the claim is
    // only true of a muscle that does not wrap: a wrapped tendon leaves its origin along the
    // first segment of its path, which can point well away from the far end. It passed for as
    // long as the body happened to land with this one unwrapped -- and the note at the top of
    // this file says plainly that these readings are taken from wherever the body lands, and
    // that it had to be stripped of its discs once already to keep that landing still. The
    // published origin direction is the quantity the claim is actually about and does not care
    // where the body landed.
    const s = await driven(1);
    s.kernel.run(200);
    const i = LOADED;
    const toward = [
      s.originDirection[3 * i] as number,
      s.originDirection[3 * i + 1] as number,
      s.originDirection[3 * i + 2] as number,
    ];
    const body = s.originBody[i] as number;
    const applied = [
      s.wrenchForce[3 * body] as number,
      s.wrenchForce[3 * body + 1] as number,
      s.wrenchForce[3 * body + 2] as number,
    ];
    const dot = toward.reduce((t, v, k) => t + v * (applied[k] as number), 0);
    expect(dot).toBeGreaterThan(0);
    s.kernel.dispose();
  });

  it('loads every tendon that has any length left to pull with', async () => {
    // This test used to assert the opposite, and the change is the point of the via points. With
    // straight paths three of the seven units were shorter than their own resting length, so
    // their tendons never took up and they made no force however hard they were driven. Holding
    // each muscle against the humerus lengthened its path enough that they load.
    //
    // Brachioradialis is allowed to be the exception, and only once its origin was measured along
    // the ridge rather than taken from the ridge's marker. That gave it the moment arm it should
    // have -- 64 mm at the peak against 18 before -- and a moment arm is an excursion: the path
    // now shortens by 98 mm between a straight elbow and a bent one, on 102 mm of fiber. At full
    // flexion there is nothing left of the fiber to pull with and the tendon goes slack.
    //
    // That is the source model's own arithmetic rather than something introduced here. It runs
    // the same muscle between 0.14 and 1.42 of optimal over the same range, on the same 102 mm
    // fiber, and a real brachioradialis has fascicles half as long again. The fiber length is
    // MyoSuite's and the translation cannot help it, because that only lengthens a fiber when our
    // path travels further than the source's and here it travels less. Recorded in OQ-020.
    const s = await driven(1);
    s.kernel.run(300);
    const slack: string[] = [];
    for (let i = 0; i < UNITS; i++) {
      if ((s.tendonForce[i] as number) === 0) slack.push(muscles.units[i]?.id as string);
      // Slack is a state, not a failure: what would be a failure is the solver giving up.
      expect(s.diagnostic[i] as number, muscles.units[i]?.id).toBe(0);
    }
    expect(
      slack.every((id) => id.startsWith('brachioradialis')),
      slack.join(', '),
    ).toBe(true);
    s.kernel.dispose();
  });

  it('publishes what a nerve module will need, from the first tick', async () => {
    // Section 14's forward-compatibility table: fiber length and velocity for spindle afferents,
    // tendon force for Golgi tendon organs. Asserting they are present and finite now is what
    // stops them being quietly dropped before anything reads them.
    const s = await driven(0.4);
    s.kernel.run(50);
    for (let i = 0; i < UNITS; i++) {
      expect(Number.isFinite(s.fiberLength[i] as number), muscles.units[i]?.id).toBe(true);
      expect(Number.isFinite(s.tendonForce[i] as number), muscles.units[i]?.id).toBe(true);
      expect(Number.isFinite(s.fiberForce[i] as number), muscles.units[i]?.id).toBe(true);
    }
    s.kernel.dispose();
  });

  it('declares the gamma channel even though nothing uses it', async () => {
    const s = await session();
    const given = s.dynamics.manifest.gives.map((c) => c.id);
    expect(given).toContain('efferent.gammaMotor');
    expect(given).toContain('efferent.alphaMotor');
    s.kernel.dispose();
  });

  it('holds a repeatable state: two identical runs agree exactly', async () => {
    // Determinism is what makes a bug reproducible from a session file, and it is the rule the
    // module lint enforces statically. This is the same claim checked dynamically.
    const pattern: DrivePattern = { kind: 'sine', mean: 0.5, amplitude: 0.45, frequency: 1.5 };
    const a = await session(pattern);
    const b = await session(pattern);
    a.kernel.run(300);
    b.kernel.run(300);
    expect(Array.from(a.tendonForce)).toEqual(Array.from(b.tendonForce));
    expect(Array.from(a.fiberLength)).toEqual(Array.from(b.fiberLength));
    a.kernel.dispose();
    b.kernel.dispose();
  });
});

/** Where `withMoments` holds the arm, radians. The left elbow stays where it started unless told. */
interface MomentPose {
  readonly elbow?: number;
  readonly leftElbow?: number;
  readonly pronation?: number;
  /** The whole body turned about the vertical, radians. */
  readonly turn?: number;
}

/**
 * Each unit's elbow pair, by unit id.
 *
 * Only the elbow's: the biceps crosses the forearm's turn too, and its pair for that comes after
 * its elbow pair, so a map of every pair by unit alone kept the forearm's arm under the biceps's
 * name. The flexor-sign and biceps-peak tests below read that one for as long as they have
 * existed, and passed only while a misplaced pronation axis gave the biceps a positive arm there.
 */
function elbowPairs(moment: MuscleMomentModule): Map<string, number> {
  return new Map(
    moment.pairs.flatMap((p, i) =>
      p.jointId.startsWith('elbow_') ? [[p.unitId, i] as const] : [],
    ),
  );
}

describe('MuscleMomentModule', () => {
  /** A session with the diagnostics module registered alongside the rest. */
  /**
   * The moment modules, with the elbow held where the test means rather than where a limp body
   * happens to land.
   *
   * These used to run the body for four hundred ticks under gravity with every muscle silent and
   * read the arm in whatever heap it collapsed into. That pose is not a statement about anything:
   * it moved when the *hand* gained muscles and joint centres it had nothing to do with, and the
   * biceps read -11 mm in it -- while a proper sweep has the same muscle between +12 and +44 mm at
   * every forearm rotation and every elbow angle. This file already makes the argument a few tests
   * down: "a sweep that does not say where the forearm was is not reproducible." So gravity is off
   * and the pose is imposed, as `sweepMomentArms` does it.
   */
  async function withMoments(pose: MomentPose = {}, { forces = true } = {}) {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const backend = new MujocoBackend();
    kernel.register(new PhysicsModule(backend, articulation, { gravity: { x: 0, y: 0, z: 0 } }));
    if (forces) {
      kernel.register(
        new MuscleTestDriveModule(muscles, [
          { units: 'all', pattern: { kind: 'constant', level: 0 } },
        ]),
      );
    }
    kernel.register(new MusclePathModule(articulation, muscles));
    if (forces) kernel.register(new MuscleDynamicsModule(articulation, muscles));
    const moment = new MuscleMomentModule(articulation, muscles);
    kernel.register(moment);
    await kernel.init();
    const fields = kernel.channels.storage(DIAGNOSTICS_MOMENT_ARM).fields;
    const length = kernel.channels.storage(MUSCLE_PATH).fields.length as Float64Array;
    const buffers = allocateBuffers(articulation);
    backend.readJointState(buffers.jointState);
    const { q, qdot } = buffers.jointState;
    const elbow = coordinateIndex(articulation, 'elbow_r', 'flexion');
    const leftElbow = coordinateIndex(articulation, 'elbow_l', 'flexion');
    const pronation = coordinateIndex(articulation, 'radioulnar_r', 'pronation');
    const leftAtRest = q[ROOT_NQ + leftElbow] as number;
    // The root's orientation as it started, x y z w, for `turn` to compose onto.
    const [rx, ry, rz, rw] = [q[3], q[4], q[5], q[6]] as number[];

    /** Impose a pose for one tick: the body starts the tick there, at rest. */
    const impose = (at: MomentPose) => {
      qdot.fill(0);
      q[ROOT_NQ + elbow] = at.elbow ?? 0.5;
      q[ROOT_NQ + leftElbow] = at.leftElbow ?? leftAtRest;
      q[ROOT_NQ + pronation] = at.pronation ?? 0;
      // The whole body turned about the vertical (+Y) through the root, composed onto where it
      // started: a rigid motion, so it changes where every joint axis points and no moment arm.
      const sin = Math.sin((at.turn ?? 0) / 2);
      const cos = Math.cos((at.turn ?? 0) / 2);
      q[3] = cos * (rx as number) + sin * (rz as number);
      q[4] = cos * (ry as number) + sin * (rw as number);
      q[5] = cos * (rz as number) - sin * (rx as number);
      q[6] = cos * (rw as number) - sin * (ry as number);
      backend.writeJointState(q, qdot);
      kernel.run(1);
    };
    /**
     * Hold a pose long enough that the moment module has certainly seen it. It runs at a tenth of
     * the physics rate, and in twelve ticks it fires at least once after the first, which is the
     * tick that still starts from wherever the body was before.
     */
    const hold = (at: MomentPose) => {
      for (let tick = 0; tick < 12; tick++) impose(at);
    };

    hold(pose);
    return { kernel, moment, arm: fields.arm as Float64Array, length, impose, hold };
  }

  it('pairs every unit with the elbow coordinate it crosses', () => {
    // Seven units on each arm, all crossing that arm's own hinge. A unit that crossed nothing
    // would be a muscle anchored to one bone at both ends; a unit paired with a coordinate it
    // does not cross would report leverage it does not have; and a left unit paired with the
    // right elbow would be a muscle reaching across the body.
    const moment = new MuscleMomentModule(articulation, muscles);
    for (const side of ['r', 'l']) {
      const elbow = moment.pairs.filter((p) => p.jointId === `elbow_${side}`);
      expect(elbow, side).toHaveLength(7);
      expect(new Set(elbow.map((p) => p.unitId)).size, side).toBe(7);
      expect(
        elbow.every((p) => p.dofId === 'flexion' && p.unitId.endsWith(`_${side}`)),
        side,
      ).toBe(true);
    }
  });

  it('holds the triceps at the trochlea’s radius instead of letting it reverse', async () => {
    // The finding this module exists for, as a test. With straight-line paths the triceps moment
    // arm fell to zero at about 2 rad of flexion and then changed sign, making the extensor a
    // flexor -- the hard failure of muscle spec 13.2. Wrapping holds it at the surface's radius,
    // which is what a pulley does and what published curves show.
    //
    // The bounds are the surface, so they move when the surface is measured again. The floor was
    // 10 mm when the trochlea measured 18.0; putting the epicondyle markers back on the bone made
    // the distal humerus the width of a real one and the trochlea 12.4, and the arm followed it
    // down to just under 10. What the test is for is that the arm stays negative and stays off
    // zero -- how close it is to a published curve is the moment-arm gate's business, and it says
    // this one is still 6 mm out (OQ-015).
    const s = await withMoments();
    const index = elbowPairs(s.moment);
    for (const id of [
      'triceps_brachii_long_r',
      'triceps_brachii_lateral_r',
      'triceps_brachii_medial_r',
    ]) {
      const at = index.get(id) as number;
      const arm = s.arm[at] as number;
      expect(arm, id).toBeLessThan(0);
      expect(Math.abs(arm), id).toBeGreaterThan(0.008);
      expect(Math.abs(arm), id).toBeLessThan(0.035);
    }
    s.kernel.dispose();
  });

  it('gives the flexors the opposite sign to the extensors', async () => {
    const s = await withMoments();
    const index = elbowPairs(s.moment);
    const arm = (id: string) => s.arm[index.get(id) as number] as number;
    expect(arm('brachialis_r')).toBeGreaterThan(0);
    expect(arm('biceps_brachii_long_r')).toBeGreaterThan(0);
    expect(arm('triceps_brachii_long_r')).toBeLessThan(0);
    s.kernel.dispose();
  });

  it('keeps every unit on one side of the joint through the whole range', async () => {
    // Muscle spec 13.2's hard failure, swept rather than sampled at one pose -- which is the only
    // way to see it. `pnpm validate:moment-arms` makes the same check against the reference model
    // and reports how far each curve is from it; this is here because the rule is about our model
    // alone and should fail in the test suite, not only in a tool somebody has to run.
    //
    // Brachioradialis is why it is written: its wrap sat after every via point, which put the
    // obstacle on the span running down the forearm instead of the one crossing the elbow, and
    // its arm went negative at full extension.
    const sweep = await sweepMomentArms({
      articulation,
      muscles,
      backend: () => new MujocoBackend(),
      jointId: 'elbow_r',
      axisName: 'flexion',
      angles: degreeRange(0, 130, 10),
      hold: [{ jointId: 'radioulnar_r', axisName: 'pronation', value: 0 }],
    });
    for (let p = 0; p < sweep.pairs.length; p++) {
      const pair = sweep.pairs[p];
      if (!pair || pair.jointId !== 'elbow_r' || pair.dofId !== 'flexion') continue;
      // A hair either side of zero is not a side change; a millimetre of leverage is.
      const signs = Array.from(sweep.arms[p] as Float64Array)
        .filter((arm) => Math.abs(arm) > 1e-3)
        .map((arm) => Math.sign(arm));
      expect(new Set(signs).size, `${pair.unitId} changes sign across the range`).toBe(1);
    }
  }, 60_000);

  it('peaks the biceps where published data peaks it', async () => {
    // What the via points bought. With the path running straight from the humerus to the radial
    // tuberosity the biceps peaked at 65 mm against a published 36 to 40, and reversed sign at
    // deep flexion; carrying the reference model's two points on the radius across brings the
    // peak to 39 mm and removes the reversal.
    const s = await withMoments();
    const index = elbowPairs(s.moment);
    for (const id of ['biceps_brachii_long_r', 'biceps_brachii_short_r']) {
      const arm = s.arm[index.get(id) as number] as number;
      expect(arm, id).toBeGreaterThan(0);
      expect(arm, id).toBeLessThan(0.045);
    }
    s.kernel.dispose();
  });

  it('reports arms of a plausible size for a human elbow', async () => {
    const s = await withMoments();
    for (let i = 0; i < s.moment.pairs.length; i++) {
      const arm = s.arm[i] as number;
      expect(Number.isFinite(arm), s.moment.pairs[i]?.unitId).toBe(true);
      // Nothing at the elbow levers more than a hand's breadth.
      expect(Math.abs(arm), s.moment.pairs[i]?.unitId).toBeLessThan(0.1);
    }
    s.kernel.dispose();
  });

  it('is the derivative of the length the path module publishes, across the elbow’s range', async () => {
    // The production check that the module's closed form is the derivative of *this* path: the
    // arm it reports, against the length `muscle.path` publishes with the elbow a hair either side,
    // differenced. The two share nothing but the path -- one sums sweeps about an axis the module
    // works out from the joint frames, the other re-solves the whole path, wraps and all, at two
    // poses and subtracts. Both elbows move together, so every elbow pair is checked in one pass;
    // each unit crosses only its own side's.
    //
    // The muscles make no force here. The pose is imposed at rest before every tick, but the body
    // still takes one step from it before the next tick's path is solved, and the passive force of
    // an undriven muscle -- which depends on where its fiber has got to, so on the poses before --
    // moves it by a different few microradians at each end of the difference. Divided by a step of
    // 2e-4 rad, that was up to a millimetre of disagreement that had nothing to do with either
    // side of the comparison.
    //
    // For the same reason each end of the range is pulled in a little: at the elbow's limits, the
    // step past the limit is undone by the limit before the path is solved.
    //
    // A unit with nothing but via points differences to round-off. A wrapped one differences to
    // how far its contact points have converged; measured, every elbow unit wraps and agreed to
    // within 3e-9 m, so the bound is loose enough for a harder pose and tight enough that an arm
    // about the wrong axis or from the wrong pose cannot pass.
    const s = await withMoments({}, { forces: false });
    const wraps = muscles.paths.map((path) => path.elements.some((e) => e.kind === 'wrap'));
    const elbowPairs = s.moment.pairs
      .map((pair, index) => ({ pair, index }))
      .filter(({ pair }) => pair.jointId.startsWith('elbow_') && pair.dofId === 'flexion');
    expect(elbowPairs).toHaveLength(14);

    const range = articulation.dofs[coordinateIndex(articulation, 'elbow_r', 'flexion')]
      ?.range as readonly [number, number];
    const margin = 10 * DIFFERENCE_STEP;
    const lengthsAt = (angle: number) => {
      s.hold({ elbow: angle, leftElbow: angle });
      return Float64Array.from(s.length);
    };
    for (const swept of degreeRange(0, 130, 10)) {
      const angle = Math.min(Math.max(swept, range[0] + margin), range[1] - margin);
      const above = lengthsAt(angle + DIFFERENCE_STEP);
      const below = lengthsAt(angle - DIFFERENCE_STEP);
      s.hold({ elbow: angle, leftElbow: angle });
      for (const { pair, index } of elbowPairs) {
        const differenced = momentArmByDifference((delta) =>
          delta > 0 ? (above[pair.unit] as number) : (below[pair.unit] as number),
        );
        const tolerance = wraps[pair.unit] ? 1e-6 : 1e-8;
        const label = `${pair.unitId} at ${angle.toFixed(4)} rad`;
        expect(Math.abs((s.arm[index] as number) - differenced), label).toBeLessThan(tolerance);
      }
    }
    s.kernel.dispose();
  }, 60_000);

  it('reads the joint axes from the pose the path was solved from', async () => {
    // The path module solves in `actuate`, from the pose the tick starts in. When this module ran
    // in `post`, it read the joint axes from the pose the solve had just produced: the polyline was
    // a step older than the axes it was differentiated about. A held pose hides that, because the
    // two poses are the same, so here the body is thrown between two poses every other tick and
    // the arms are read at every tick the module fires. They must be the arms of the pose the path
    // was solved from -- the one imposed the tick before -- as the module reports them for that
    // pose held still.
    //
    // Three things about the motion are deliberate. The elbow alone would barely show the fault:
    // an elbow's axis is fixed in the upper arm, and bending the elbow does not move the upper
    // arm, so the whole body turns as well -- a rigid motion that changes every axis and no arm.
    // In `post` that put the arms out by 50 mm and more; in `actuate` they match to the last bit.
    // The poses change every second tick rather than every tick, which lands a change on each tick
    // the module fires (every tenth, so always even) and still alternates which pose that is. And
    // the muscles make no force, as in the derivative test above: the reference is a held pose,
    // and passive force with a different history would move the body by a different few
    // microradians in the one step it takes before the path is solved.
    const POSES: readonly MomentPose[] = [
      { elbow: 0.3, turn: 0 },
      { elbow: 1.3, turn: 1 },
    ];
    const held: Float64Array[] = [];
    for (const pose of POSES) {
      const still = await withMoments(pose, { forces: false });
      held.push(Float64Array.from(still.arm));
      still.kernel.dispose();
    }

    const s = await withMoments(POSES[0], { forces: false });
    const elbowPairs = s.moment.pairs
      .map((pair, index) => ({ pair, index }))
      .filter(({ pair }) => pair.jointId === 'elbow_r' && pair.dofId === 'flexion');
    expect(elbowPairs).toHaveLength(7);

    let previous = 0;
    const checked = new Set<number>();
    for (let n = 0; n < 60; n++) {
      const tick = s.kernel.clock.tick;
      const which = Math.floor(tick / 2) % 2;
      const fires = tick % (s.moment.manifest.rateDivisor ?? 1) === 0;
      s.impose(POSES[which] ?? {});
      if (!fires) {
        previous = which;
        continue;
      }
      expect(which, `the pose changes at tick ${tick}`).not.toBe(previous);
      checked.add(previous);
      for (const { pair, index } of elbowPairs) {
        const expected = (held[previous] as Float64Array)[index] as number;
        const label = `${pair.unitId} at tick ${tick}, solved at ${POSES[previous]?.elbow} rad`;
        expect(Math.abs((s.arm[index] as number) - expected), label).toBeLessThan(1e-9);
      }
      previous = which;
    }
    expect(checked.size).toBe(2);
    s.kernel.dispose();
  }, 60_000);

  it('runs after the path module and writes nothing the simulation reads', async () => {
    // M-ADR-003: the moment arm is a diagnostic. If anything in the force path ever started
    // reading this channel, the comparison against cadaver data would stop being independent.
    // It runs in `actuate`, after the path module in the same phase, so that the pose it reads the
    // joint axes from is the pose the path was solved from.
    const moment = new MuscleMomentModule(articulation, muscles);
    expect(moment.manifest.phase).toBe('actuate');
    expect(moment.manifest.dependsOn.map((d) => d.id)).toContain(MUSCLE_PATH_MODULE_ID);
    expect(moment.manifest.accumulates).toEqual([]);
    expect(moment.manifest.writes.map((c) => c.id)).toEqual([DIAGNOSTICS_MOMENT_ARM]);
    expect(moment.manifest.rateDivisor).toBe(10);
  });
});

describe('MuscleVolumeModule', () => {
  it('sweeps often enough that the flesh does not lag the bones', () => {
    // The fault this rule fixes is visible rather than numerical: at a fixed tenth of the physics
    // rate the mesh refreshes 50 times a second against a display drawing 60 frames a second, so
    // the bones move every frame and the muscles move on most of them. What that looks like is
    // the flesh juddering behind the skeleton.
    expect(rateDivisorFor(500, DEFAULT_UPDATE_HZ)).toBe(4);
    expect(rateDivisorFor(1000, DEFAULT_UPDATE_HZ)).toBe(8);
    expect(DEFAULT_UPDATE_HZ).toBeGreaterThan(60);
    for (const rate of [240, 500, 1000, 2000]) {
      const divisor = rateDivisorFor(rate, DEFAULT_UPDATE_HZ);
      expect(rate / divisor, `${rate} Hz`).toBeGreaterThanOrEqual(DEFAULT_UPDATE_HZ);
    }
  });

  it('sweeps every tick when it is not told the rate, rather than guessing one', () => {
    expect(rateDivisorFor(undefined, DEFAULT_UPDATE_HZ)).toBe(1);
    expect(rateDivisorFor(0, DEFAULT_UPDATE_HZ)).toBe(1);
    // And a simulation slower than the target draws every tick, not less than one.
    expect(rateDivisorFor(60, DEFAULT_UPDATE_HZ)).toBe(1);
  });

  it('sweeps every tick unless asked not to, so a stepped tick shows its own shape', () => {
    // What a step is for: seeing the state the simulation is in. A mesh on a divisor would show
    // the shape from a few ticks back, and the muscles would sit still for most steps.
    const volume = new MuscleVolumeModule(articulation, muscles);
    expect(volume.manifest.rateDivisor).toBe(1);
    // And the way out, for a set large enough to need one.
    const thrifty = new MuscleVolumeModule(articulation, muscles, { simulationRateHz: 500 });
    expect(thrifty.manifest.rateDivisor).toBe(4);
  });

  it('writes only to the renderer, whatever its rate', () => {
    // M-ADR-004: a module that declares no accumulator cannot reach the force path at all.
    const volume = new MuscleVolumeModule(articulation, muscles);
    expect(volume.manifest.accumulates).toEqual([]);
    expect(volume.manifest.phase).toBe('post');
  });
});
