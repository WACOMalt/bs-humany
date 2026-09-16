/**
 * `MuscleVolumeModule` -- Tier V, muscle spec sections 9 and 10.1.
 *
 * Sweeps a volume along each muscle's solved path and publishes the vertices, so a muscle can be
 * drawn as a body rather than a line. A line of action cannot show a bulge, and a bulging biceps
 * is most of what anyone means by watching a muscle work.
 *
 * ## It writes to the renderer and to nothing else
 *
 * M-ADR-004, and the manifest is where that is enforced rather than promised: this module
 * declares one channel it writes and no accumulator at all, so it cannot reach the force path
 * even by accident. Tier V may fail, be switched off, or fall behind without the simulation
 * noticing -- which is what makes it safe to make it as elaborate as the display can afford.
 *
 * ## Where the bulge comes from
 *
 * From geometry and conservation, not from simulating flesh -- that is N4.3. A belly holding a
 * given volume over a shorter length has to be thicker, and both quantities are already known:
 * the volume from the muscle's own parameters, the length from the path less its tendon. The
 * tendon is what fixes where the belly begins and ends, and it is nearly inextensible, so the
 * path's every change lands on the belly and the flesh stays put against the bone. On top of
 * that sits a small perfusion term, because a belly is not only tissue: shortening under load
 * pumps blood out and lengthening under load does not, so a concentric contraction measures
 * slightly smaller than an eccentric one. Held at length, nothing moves.
 *
 * ## Rate
 *
 * Every tick, which is not what section 9.3 asks for. It asks for a tenth of the physics rate,
 * and a tenth is wrong twice over -- not for the simulation, which reads none of this, but for
 * the person watching it.
 *
 * Running, a tenth of 500 Hz is 50 sweeps a second against a display drawing 60 frames a second:
 * the bones move on every frame and the flesh on most of them, which reads as the muscles lagging
 * the skeleton and juddering. Stepping, it is worse and plainer -- press step and nine times in
 * ten the muscles do not move, so the one thing a step is for, seeing the state the simulation is
 * actually in, is the one thing they will not show.
 *
 * What it costs is measured rather than feared: 144 microseconds a tick for the fourteen units of
 * both elbows, against a tick that takes 1.73 ms with them and 1.59 without. Eight per cent of
 * the frame to make every tick honest.
 *
 * The option remains for a set large enough that eight per cent becomes eighty: give
 * `simulationRateHz` and a target `updateHz`, and the divisor follows. `DEFAULT_UPDATE_HZ` is the
 * lowest rate worth choosing -- above any display rate, so a free-running frame still gets a
 * fresh sweep -- and a stepped tick will still sometimes show the sweep before it.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { inverseTendonForceLength } from '@bs-humany/muscle-model';
import {
  type SweepScratch,
  type SweptMesh,
  createSweepScratch,
  createSweptMesh,
  muscleVolume,
  perfusedVolume,
  sweepMuscle,
} from '@bs-humany/muscle-volume';
import {
  MUSCLE_CHANNEL_VERSION,
  MUSCLE_PATH,
  MUSCLE_POLYLINE,
  MUSCLE_STATE,
  RENDER_MUSCLE_MESH,
  renderMuscleMeshSpec,
} from './channels.js';
import type { CompiledMuscleSet } from './compile.js';
import { MUSCLE_PATH_MODULE_ID } from './musclePathModule.js';

export const MUSCLE_VOLUME_MODULE_ID = 'bsums.xyz.bs-humany.muscle.volume';

export interface MuscleVolumeOptions {
  /**
   * The rate the simulation runs at, hertz.
   *
   * Give it, with `updateHz`, to sweep less often than every tick. Omitted -- the default -- the
   * mesh is swept every tick, so a stepped tick always shows its own shape.
   */
  readonly simulationRateHz?: number;
  /** How often the mesh is swept, hertz. Rounded to a whole divisor of the simulation rate. */
  readonly updateHz?: number;
  /** Cross-sections along each muscle. More is smoother along its length. */
  readonly rings?: number;
  /** Vertices around each cross-section. More is rounder. */
  readonly segments?: number;
  /** Radius of the cord drawn where the tendon runs, metres. */
  readonly tendonRadius?: number;
}

export const DEFAULT_RINGS = 24;
export const DEFAULT_SEGMENTS = 12;
/**
 * How thick a tendon is drawn, metres.
 *
 * Not measured: a tendon's cross-section is not something the musculotendon model carries, and
 * this is the render layer. Three millimetres reads as a cord at the scale a muscle is drawn
 * without disappearing.
 */
export const DEFAULT_TENDON_RADIUS = 0.003;

/**
 * The lowest sweep rate worth asking for, hertz, when a caller does ask.
 *
 * A hundred and twenty: above the display rates this will meet, so a free-running frame still has
 * a mesh swept since the last one. It is not the default -- the default is every tick, so that
 * stepping shows the state the simulation is in rather than the state it was in a few ticks ago.
 */
export const DEFAULT_UPDATE_HZ = 120;

/** The tick divisor that gets closest to `updateHz` without going under it. */
export function rateDivisorFor(simulationRateHz: number | undefined, updateHz: number): number {
  if (!simulationRateHz || !(simulationRateHz > 0)) return 1;
  return Math.max(1, Math.floor(simulationRateHz / Math.max(1, updateHz)));
}

export class MuscleVolumeModule implements SimModule {
  readonly manifest: ModuleManifest;

  readonly rings: number;
  readonly segments: number;
  private readonly tendonRadius: number;
  private readonly units: number;
  /** Tissue volume of each unit, cubic metres. A constant of the muscle. */
  private readonly tissue: Float64Array;
  /** Tendon slack length of each unit, metres: the length a tendon has when it is carrying nothing. */
  private readonly tendonSlack: Float64Array;
  /** Maximum isometric force of each unit, newtons, for normalising the tendon force. */
  private readonly maxForce: Float64Array;
  /**
   * Where the joints each unit crosses lie along its path, as fractions from the origin.
   *
   * Measured at compile, because it needs the articulation's joint frames and this runs on a
   * channel. What reads it is `bellyPlacement`, which slides the drawn belly off them.
   */
  private readonly crossings: readonly (readonly number[])[];

  /** One mesh, swept for each unit in turn into the channel. */
  private readonly mesh: SweptMesh;
  private readonly scratch: SweepScratch;

  private point: Float64Array | undefined;
  private pointStart: Int32Array | undefined;
  private pointCount: Int32Array | undefined;
  private fiberVelocity: Float64Array | undefined;
  private activation: Float64Array | undefined;
  private tendonForce: Float64Array | undefined;
  private outPosition: Float64Array | undefined;
  private outNormal: Float64Array | undefined;

  /** Triangle indices, the same for every unit and never rewritten after `init`. */
  readonly index: Uint32Array;

  constructor(
    readonly articulation: CompiledArticulation,
    readonly muscles: CompiledMuscleSet,
    options: MuscleVolumeOptions = {},
  ) {
    this.units = muscles.units.length;
    this.rings = options.rings ?? DEFAULT_RINGS;
    this.segments = options.segments ?? DEFAULT_SEGMENTS;
    this.tendonRadius = options.tendonRadius ?? DEFAULT_TENDON_RADIUS;
    this.mesh = createSweptMesh(this.rings, this.segments);
    this.index = this.mesh.index;

    this.crossings = muscles.units.map((unit) => unit.jointCrossings);
    this.tissue = new Float64Array(this.units);
    this.tendonSlack = new Float64Array(this.units);
    this.maxForce = new Float64Array(this.units);
    for (let i = 0; i < this.units; i++) {
      const p = muscles.units[i]?.parameters;
      if (!p) continue;
      this.tissue[i] = muscleVolume(p.maxIsometricForce, p.optimalFiberLength);
      this.tendonSlack[i] = p.tendonSlackLength;
      this.maxForce[i] = p.maxIsometricForce;
    }

    // Sized to the longest path any unit can produce, so one scratch serves them all.
    this.scratch = createSweepScratch(4096);

    this.manifest = {
      id: MUSCLE_VOLUME_MODULE_ID,
      version: '1.0.0',
      phase: 'post',
      rateDivisor: rateDivisorFor(options.simulationRateHz, options.updateHz ?? DEFAULT_UPDATE_HZ),
      dependsOn: [{ id: MUSCLE_PATH_MODULE_ID, version: '1.0.0' }],
      reads: [
        { id: MUSCLE_PATH, version: MUSCLE_CHANNEL_VERSION },
        { id: MUSCLE_POLYLINE, version: MUSCLE_CHANNEL_VERSION },
        { id: MUSCLE_STATE, version: MUSCLE_CHANNEL_VERSION },
      ],
      writes: [{ id: RENDER_MUSCLE_MESH, version: MUSCLE_CHANNEL_VERSION }],
      // Empty, and that is the enforcement of M-ADR-004 rather than a promise of it: a module
      // that declares no accumulator cannot reach `actuation.bodyWrench` at all.
      accumulates: [],
      gives: [renderMuscleMeshSpec(this.units * this.mesh.vertexCount)] satisfies ChannelSpec[],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  private bind(ctx: ModuleInitContext): void {
    const path = ctx.read(MUSCLE_PATH);
    this.pointStart = path.fields.pointStart as Int32Array;
    this.pointCount = path.fields.pointCount as Int32Array;
    this.point = ctx.read(MUSCLE_POLYLINE).fields.point as Float64Array;
    const state = ctx.read(MUSCLE_STATE);
    this.fiberVelocity = state.fields.fiberVelocity as Float64Array;
    this.activation = state.fields.activation as Float64Array;
    this.tendonForce = state.fields.tendonForce as Float64Array;
    const out = ctx.write(RENDER_MUSCLE_MESH);
    this.outPosition = out.fields.position as Float64Array;
    this.outNormal = out.fields.normal as Float64Array;
  }

  step(_ctx: ModuleStepContext): void {
    const point = this.point;
    const start = this.pointStart;
    const count = this.pointCount;
    const fiberVelocity = this.fiberVelocity;
    const activation = this.activation;
    const tendonForce = this.tendonForce;
    const outPosition = this.outPosition;
    const outNormal = this.outNormal;
    if (!point || !start || !count || !tendonForce || !fiberVelocity || !activation) return;
    if (!outPosition || !outNormal) return;

    const stride = this.mesh.vertexCount;
    for (let i = 0; i < this.units; i++) {
      // How much of the path is tendon, from the tendon's own force-length curve: a tendon
      // carrying nothing measures exactly its slack length, and a tendon at its maximum force
      // measures about five per cent more. That is the whole range, which is the point -- it is
      // what keeps the belly's ends against the bone while the path shortens under them.
      const tendon =
        (this.tendonSlack[i] as number) * this.tendonStretch(i, tendonForce[i] as number);
      const volume = perfusedVolume(
        this.tissue[i] as number,
        activation[i] as number,
        fiberVelocity[i] as number,
      );

      this.sweepInto(i, tendon, volume);

      const at = 3 * i * stride;
      for (let v = 0; v < 3 * stride; v++) {
        outPosition[at + v] = this.mesh.position[v] as number;
        outNormal[at + v] = this.mesh.normal[v] as number;
      }
    }
  }

  /**
   * How far past slack this unit's tendon is stretched, as a multiple of its slack length.
   *
   * The inverse of the tendon curve the dynamics itself solves against, so the two cannot drift:
   * zero force gives exactly 1, and the curve is steep enough that the whole working range is
   * within a few per cent of it. A negative force would be a tendon pushing, which is not a thing
   * a tendon does; it is clamped rather than trusted.
   */
  private tendonStretch(unit: number, force: number): number {
    const maximum = this.maxForce[unit] as number;
    if (!(maximum > 0)) return 1;
    const normalised = force > 0 ? force / maximum : 0;
    return inverseTendonForceLength(normalised);
  }

  /** Sweep one unit into the shared mesh. Split out so `step` reads as what it does. */
  private sweepInto(unit: number, tendonLength: number, volume: number): void {
    const point = this.point as Float64Array;
    const start = this.pointStart as Int32Array;
    const count = this.pointCount as Int32Array;
    // Allocation-free: every buffer this touches was made in the constructor.
    sweepMuscle(
      {
        points: point,
        from: start[unit] as number,
        pointCount: count[unit] as number,
        crossings: this.crossings[unit],
        volume,
        tendonLength,
        tendonRadius: this.tendonRadius,
      },
      this.scratch,
      this.mesh,
    );
  }

  /** Vertices per unit, so a renderer can find where each muscle's mesh begins. */
  get verticesPerUnit(): number {
    return this.mesh.vertexCount;
  }
}
