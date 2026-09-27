/**
 * The muscle channel registry -- muscle spec section 10.2.
 *
 * Channel ids and field names are the ABI between modules. A nerve module written years from now
 * against `muscle.state@1.0.0` must find `fiberLength` and `tendonForce` there, because those are
 * what a spindle afferent and a Golgi tendon organ read; section 14 says to publish both from the
 * start for exactly that reason, and this is where that promise is kept.
 *
 * ## Why the contacts are a separate channel
 *
 * Section 10.2's table puts "length[N], velocity[N], contact list" on one row. A channel has one
 * element count, and wrap contacts are not one-per-unit -- a unit may wrap twice or not at all --
 * so they cannot share a buffer with the per-unit fields. They go in `muscle.contact`, which has a
 * fixed capacity (`DEFAULT_MUSCLE_CONTACT_CAPACITY` unless the module is built with another) and
 * no count field: it is filled from index 0, and every slot past the last contact is marked with
 * `unit = -1`, so a reader walks from the start and stops at the first -1. Contacts that do not
 * fit are not dropped silently -- `MusclePathModule.contactOverflow` counts them. This is the same
 * split the base spec already makes between `body.pose` and `contact.manifolds`.
 *
 * ## Why the path channel carries more than length and velocity
 *
 * Length and velocity are what the *fiber model* needs. Section 8.2 also has to put the force
 * somewhere, and that needs the two world points, the two directions and the two bodies. A module
 * may not reach into another module to get them, so they travel here. The result is a channel
 * that is enough on its own: anything wanting to draw a muscle, or push on the bones it attaches
 * to, reads `muscle.path` and needs nothing else.
 */

import type { ChannelSpec } from '@bs-humany/kernel';

export const MUSCLE_CHANNEL_VERSION = '1.0.0';

export const MUSCLE_PATH = 'muscle.path';
export const MUSCLE_CONTACT = 'muscle.contact';
export const MUSCLE_POLYLINE = 'muscle.polyline';
export const MUSCLE_STATE = 'muscle.state';
export const DIAGNOSTICS_MOMENT_ARM = 'diagnostics.momentArm';
export const RENDER_MUSCLE_MESH = 'render.muscleMesh';
export const EFFERENT_ALPHA_MOTOR = 'efferent.alphaMotor';
export const EFFERENT_GAMMA_MOTOR = 'efferent.gammaMotor';

/** Wrap contacts a tick may report before the buffer overflows. Overflow is counted, not dropped. */
export const DEFAULT_MUSCLE_CONTACT_CAPACITY = 256;

export function musclePathSpec(units: number): ChannelSpec {
  return {
    id: MUSCLE_PATH,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      /** Metres, origin to insertion along the path. */
      { name: 'length', dtype: 'f64', components: 1 },
      /** Metres per second. Computed from body velocities, never differenced (section 5.3). */
      { name: 'velocity', dtype: 'f64', components: 1 },
      /** Segment index the origin is fixed to. */
      { name: 'originBody', dtype: 'i32', components: 1 },
      { name: 'insertionBody', dtype: 'i32', components: 1 },
      /** World metres. */
      { name: 'originPoint', dtype: 'f64', components: 3 },
      { name: 'insertionPoint', dtype: 'f64', components: 3 },
      /** Unit, world, from the origin toward the next point on the path. */
      { name: 'originDirection', dtype: 'f64', components: 3 },
      /** Unit, world, from the insertion toward the previous point on the path. */
      { name: 'insertionDirection', dtype: 'f64', components: 3 },
      /** Where this unit's points begin in `muscle.polyline`, and how many it wrote. */
      { name: 'pointStart', dtype: 'i32', components: 1 },
      { name: 'pointCount', dtype: 'i32', components: 1 },
    ],
    elementCount: units,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export function muscleContactSpec(capacity = DEFAULT_MUSCLE_CONTACT_CAPACITY): ChannelSpec {
  return {
    id: MUSCLE_CONTACT,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      /** Index of the unit this contact belongs to. */
      { name: 'unit', dtype: 'i32', components: 1 },
      /** Segment index of the body the wrapped surface is attached to. */
      { name: 'body', dtype: 'i32', components: 1 },
      /** World metres. */
      { name: 'point', dtype: 'f64', components: 3 },
      /**
       * World. The sum of the two unit tangents at the wrap, pointing into the bone:
       * `-(u_A + u_B)`, with a magnitude from 0 to 2 by how sharply the tendon turns there. Not
       * normalised: multiply by the tendon force to get the reaction on `body` (muscle spec 8.2
       * step 4).
       */
      { name: 'direction', dtype: 'f64', components: 3 },
    ],
    elementCount: capacity,
    mode: 'single-writer',
    backing: 'shared',
  };
}

/**
 * Every point of every muscle's path, end to end, for anything that draws one.
 *
 * A second channel rather than more fields on `muscle.path`, because a channel has one element
 * count and a path's point count is not one per unit -- a straight unit has two and a wrapped one
 * has fifteen. `muscle.path` carries the offset and count into this, the same way a contact list
 * is indexed.
 *
 * It exists for readers, not for the solver. The length the fiber model integrates is the exact
 * arc length, never a sum of these chords, so the picture can be coarse without the physics being.
 */
export function musclePolylineSpec(capacity: number): ChannelSpec {
  return {
    id: MUSCLE_POLYLINE,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'point', dtype: 'f64', components: 3 },
      /**
       * The body carrying each point: the bone an attachment is pinned to, or the bone whose
       * surface an arc point lies on. Without it a reader has the path's shape but not what moves
       * it, and a moment arm is entirely a question of which points a coordinate carries.
       */
      { name: 'body', dtype: 'i32', components: 1 },
    ],
    elementCount: capacity,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export function muscleStateSpec(units: number): ChannelSpec {
  return {
    id: MUSCLE_STATE,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      /** 0 to 1. */
      { name: 'activation', dtype: 'f64', components: 1 },
      /** Optimal fiber lengths. Spindle afferents read this (section 14). */
      { name: 'fiberLength', dtype: 'f64', components: 1 },
      /** Optimal fiber lengths per second, over the maximum contraction velocity. */
      { name: 'fiberVelocity', dtype: 'f64', components: 1 },
      /** Newtons. Golgi tendon organ afferents read this (section 14). */
      { name: 'tendonForce', dtype: 'f64', components: 1 },
      /** Newtons, along the fiber rather than along the tendon. */
      { name: 'fiberForce', dtype: 'f64', components: 1 },
      /**
       * Nonzero when this unit did not solve cleanly this tick.
       *
       * A bit field, `MUSCLE_EQUILIBRIUM_FAILED | MUSCLE_FIBER_OUT_OF_RANGE`. Bit 1: the
       * elastic-tendon equilibrium hit its bracket, which a rigid unit never does because it
       * has no equilibrium to search for. Bit 2: the fiber was held at `FIBER_LENGTH_MINIMUM` or
       * `FIBER_LENGTH_MAXIMUM` this tick, or a rigid unit's path is shorter than its tendon. A
       * muscle that failed still publishes a force, because stopping the simulation is worse;
       * this is how a reader finds out that the force it is reading is the fallback.
       */
      { name: 'diagnostic', dtype: 'i32', components: 1 },
    ],
    elementCount: units,
    mode: 'single-writer',
    backing: 'shared',
  };
}

/** Diagnostic bits on `muscle.state`. */
export const MUSCLE_OK = 0;
/** The elastic-tendon equilibrium hit its bracket this tick. Never set for a rigid unit. */
export const MUSCLE_EQUILIBRIUM_FAILED = 1;
/**
 * The fiber was held at `FIBER_LENGTH_MINIMUM` or `FIBER_LENGTH_MAXIMUM` this tick rather than
 * left to go past it, or a rigid unit's path is shorter than its tendon.
 */
export const MUSCLE_FIBER_OUT_OF_RANGE = 2;

/**
 * Muscle surface vertices, for drawing (muscle spec 9.3).
 *
 * One element per vertex, with every unit's mesh laid end to end in the same order the units are
 * in, so a renderer finds a muscle's vertices at `unit * verticesPerUnit`. The triangle indices
 * are not here: a sweep's connectivity depends only on how many rings and segments it has, so it
 * is built once and never changes, and putting it in a per-tick channel would be publishing a
 * constant.
 *
 * Read by the renderer and by nothing else. Tier V writes here and to nowhere else (M-ADR-004).
 */
export function renderMuscleMeshSpec(vertices: number): ChannelSpec {
  return {
    id: RENDER_MUSCLE_MESH,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      /** World metres. */
      { name: 'position', dtype: 'f64', components: 3 },
      /** Unit, world. */
      { name: 'normal', dtype: 'f64', components: 3 },
    ],
    elementCount: Math.max(1, vertices),
    mode: 'single-writer',
    backing: 'shared',
  };
}

/**
 * How much leverage each muscle has over each joint coordinate it crosses.
 *
 * One element per (unit, coordinate) pair rather than a matrix, because the matrix would be
 * almost all zeros: a muscle crosses one or two joints out of a hundred. The pairs are fixed at
 * compile time, so a reader can look up which row is which once and then read the arms every
 * tick.
 *
 * Output only (M-ADR-003). Nothing in the simulation reads it, which is what makes it worth
 * having: a quantity the simulation depends on can only tell you the model is self-consistent,
 * while one it does not can be held against a cadaver measurement with nothing circular in the
 * comparison.
 */
export function diagnosticsMomentArmSpec(pairs: number): ChannelSpec {
  return {
    id: DIAGNOSTICS_MOMENT_ARM,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'unit', dtype: 'i32', components: 1 },
      /** Index into the articulation's flat DoF list. */
      { name: 'dof', dtype: 'i32', components: 1 },
      /** Metres. Positive when the muscle's tension drives the coordinate positive. */
      { name: 'arm', dtype: 'f64', components: 1 },
    ],
    elementCount: Math.max(1, pairs),
    mode: 'single-writer',
    backing: 'shared',
  };
}

/**
 * Motor drive, 0 to 1 per unit.
 *
 * An accumulator shared by every source of drive. MuscleTestDriveModule writes the feedforward
 * layer -- a scenario's scripted tone and the panel's sliders -- and SpinalModule, NervesModule
 * and MotorNoiseModule each add their own term on top in the same tick. MuscleDynamicsModule is
 * the one reader, and clamps the sum to 0 to 1 as it turns it into activation. It is multi-writer because section 14 asks for a
 * channel several writers can share: a real muscle receives drive from more than one descending
 * pathway and a reflex arc on top, and a single-writer channel would have meant changing the ABI
 * the first time a second source of drive existed.
 */
export function efferentAlphaMotorSpec(units: number): ChannelSpec {
  return {
    id: EFFERENT_ALPHA_MOTOR,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [{ name: 'excitation', dtype: 'f64', components: 1 }],
    elementCount: units,
    mode: 'accumulator',
    backing: 'local',
  };
}

/**
 * Spindle sensitivity, per unit. Declared, and read or written by nothing yet.
 *
 * SpinalModule does model spindle afferents -- its stretch reflex is the group II length response
 * -- but it takes their sensitivity as a fixed gain rather than reading gamma drive here, and
 * nothing writes gamma drive either. Section 14 requires the channel to exist from the start. It
 * costs one buffer and it means the module that finally drives the spindles arrives to a channel
 * that is already there rather than to a schema change.
 */
export function efferentGammaMotorSpec(units: number): ChannelSpec {
  return {
    id: EFFERENT_GAMMA_MOTOR,
    version: MUSCLE_CHANNEL_VERSION,
    layout: 'SoA',
    fields: [{ name: 'gain', dtype: 'f64', components: 1 }],
    elementCount: units,
    mode: 'accumulator',
    backing: 'local',
  };
}
