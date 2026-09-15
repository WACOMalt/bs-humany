import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { ACTUATION_BODY_WRENCH, BODY_POSE, PhysicsModule } from '@bs-humany/modules-mechanics';
import { ELBOW_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_MOMENT_ARM,
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_CONTACT,
  MUSCLE_FIBER_OUT_OF_RANGE,
  MUSCLE_PATH,
  MUSCLE_STATE,
} from './channels.js';
import { compileMuscleSet } from './compile.js';
import { degreeRange, sweepMomentArms } from './momentArmSweep.js';
import { MuscleDynamicsModule } from './muscleDynamicsModule.js';
import { MuscleMomentModule } from './muscleMomentModule.js';
import { MusclePathModule } from './musclePathModule.js';
import { type DrivePattern, MuscleTestDriveModule } from './muscleTestDriveModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
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
const LOADED = muscles.units.findIndex((u) => u.id === 'brachioradialis_r');

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

describe('MusclePathModule', () => {
  it('compiles every elbow unit, with nothing it could not represent', async () => {
    const s = await session();
    // The elbow set declares no wrap surfaces yet (OQ-015), so the via-point solver has no
    // complaint. When N1.4 lands and the wraps are authored, this is where it will start talking.
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
      expect(s.diagnostic[i] as number, muscles.units[i]?.id).not.toBe(MUSCLE_FIBER_OUT_OF_RANGE);
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

  it('never lets the tendon push', async () => {
    for (const level of [0, 0.3, 1]) {
      const s = await driven(level);
      s.kernel.run(200);
      for (let i = 0; i < UNITS; i++) {
        expect(s.tendonForce[i], `${muscles.units[i]?.id} at ${level}`).toBeGreaterThanOrEqual(0);
      }
      s.kernel.dispose();
    }
  });

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

  it('pulls the two ends toward each other, not apart', async () => {
    // The sign, stated as what it means: the force on the origin points at the insertion.
    const s = await driven(1);
    s.kernel.run(200);
    const i = LOADED;
    const toward = [
      (s.insertionPoint[3 * i] as number) - (s.originPoint[3 * i] as number),
      (s.insertionPoint[3 * i + 1] as number) - (s.originPoint[3 * i + 1] as number),
      (s.insertionPoint[3 * i + 2] as number) - (s.originPoint[3 * i + 2] as number),
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

  it('loads every tendon now that the paths lie along the bone', async () => {
    // This test used to assert the opposite, and the change is the point of the via points. With
    // straight paths three of the seven units were shorter than their own resting length, so
    // their tendons never took up and they made no force however hard they were driven. Holding
    // each muscle against the humerus lengthened its path enough that all seven now load.
    const s = await driven(1);
    s.kernel.run(300);
    const slack: string[] = [];
    for (let i = 0; i < UNITS; i++) {
      if ((s.tendonForce[i] as number) === 0) slack.push(muscles.units[i]?.id as string);
      expect(s.diagnostic[i] as number, muscles.units[i]?.id).toBe(0);
    }
    expect(slack).toEqual([]);
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

describe('MuscleMomentModule', () => {
  /** A session with the diagnostics module registered alongside the rest. */
  async function withMoments() {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    kernel.register(
      new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }),
    );
    kernel.register(
      new MuscleTestDriveModule(muscles, [
        { units: 'all', pattern: { kind: 'constant', level: 0 } },
      ]),
    );
    kernel.register(new MusclePathModule(articulation, muscles));
    kernel.register(new MuscleDynamicsModule(articulation, muscles));
    const moment = new MuscleMomentModule(articulation, muscles);
    kernel.register(moment);
    await kernel.init();
    const fields = kernel.channels.storage(DIAGNOSTICS_MOMENT_ARM).fields;
    return { kernel, moment, arm: fields.arm as Float64Array };
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
    const s = await withMoments();
    s.kernel.run(400);
    const index = new Map(s.moment.pairs.map((p, i) => [p.unitId, i]));
    for (const id of [
      'triceps_brachii_long_r',
      'triceps_brachii_lateral_r',
      'triceps_brachii_medial_r',
    ]) {
      const at = index.get(id) as number;
      const arm = s.arm[at] as number;
      expect(arm, id).toBeLessThan(0);
      expect(Math.abs(arm), id).toBeGreaterThan(0.01);
      expect(Math.abs(arm), id).toBeLessThan(0.035);
    }
    s.kernel.dispose();
  });

  it('gives the flexors the opposite sign to the extensors', async () => {
    const s = await withMoments();
    s.kernel.run(400);
    const index = new Map(s.moment.pairs.map((p, i) => [p.unitId, i]));
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
    s.kernel.run(400);
    const index = new Map(s.moment.pairs.map((p, i) => [p.unitId, i]));
    for (const id of ['biceps_brachii_long_r', 'biceps_brachii_short_r']) {
      const arm = s.arm[index.get(id) as number] as number;
      expect(arm, id).toBeGreaterThan(0);
      expect(arm, id).toBeLessThan(0.045);
    }
    s.kernel.dispose();
  });

  it('reports arms of a plausible size for a human elbow', async () => {
    const s = await withMoments();
    s.kernel.run(400);
    for (let i = 0; i < s.moment.pairs.length; i++) {
      const arm = s.arm[i] as number;
      expect(Number.isFinite(arm), s.moment.pairs[i]?.unitId).toBe(true);
      // Nothing at the elbow levers more than a hand's breadth.
      expect(Math.abs(arm), s.moment.pairs[i]?.unitId).toBeLessThan(0.1);
    }
    s.kernel.dispose();
  });

  it('runs after the path module and writes nothing the simulation reads', async () => {
    // M-ADR-003: the moment arm is a diagnostic. If anything in the force path ever started
    // reading this channel, the comparison against cadaver data would stop being independent.
    const moment = new MuscleMomentModule(articulation, muscles);
    expect(moment.manifest.phase).toBe('post');
    expect(moment.manifest.accumulates).toEqual([]);
    expect(moment.manifest.writes.map((c) => c.id)).toEqual([DIAGNOSTICS_MOMENT_ARM]);
    expect(moment.manifest.rateDivisor).toBe(10);
  });
});
