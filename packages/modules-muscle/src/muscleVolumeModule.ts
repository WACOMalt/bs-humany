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
 * the fiber length from `muscle.state`, the volume from the muscle's own parameters. On top of
 * that sits a small perfusion term, because a belly is not only tissue: shortening under load
 * pumps blood out and lengthening under load does not, so a concentric contraction measures
 * slightly smaller than an eccentric one. Held at length, nothing moves.
 *
 * ## Rate
 *
 * A tenth of the physics rate, as section 9.3 asks. Nothing in the simulation reads the result,
 * a muscle's shape changes about as fast as its fiber length does, and sweeping every unit is the
 * one part of this that costs anything worth measuring.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
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

export class MuscleVolumeModule implements SimModule {
  readonly manifest: ModuleManifest;

  readonly rings: number;
  readonly segments: number;
  private readonly tendonRadius: number;
  private readonly units: number;
  /** Tissue volume of each unit, cubic metres. A constant of the muscle. */
  private readonly tissue: Float64Array;
  /** Optimal fiber length of each unit, metres, for turning the normalised length into one. */
  private readonly optimalFiber: Float64Array;

  /** One mesh, swept for each unit in turn into the channel. */
  private readonly mesh: SweptMesh;
  private readonly scratch: SweepScratch;

  private point: Float64Array | undefined;
  private pointStart: Int32Array | undefined;
  private pointCount: Int32Array | undefined;
  private fiberLength: Float64Array | undefined;
  private fiberVelocity: Float64Array | undefined;
  private activation: Float64Array | undefined;
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

    this.tissue = new Float64Array(this.units);
    this.optimalFiber = new Float64Array(this.units);
    for (let i = 0; i < this.units; i++) {
      const p = muscles.units[i]?.parameters;
      if (!p) continue;
      this.tissue[i] = muscleVolume(p.maxIsometricForce, p.optimalFiberLength);
      this.optimalFiber[i] = p.optimalFiberLength;
    }

    // Sized to the longest path any unit can produce, so one scratch serves them all.
    this.scratch = createSweepScratch(4096);

    this.manifest = {
      id: MUSCLE_VOLUME_MODULE_ID,
      version: '1.0.0',
      phase: 'post',
      rateDivisor: 10,
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
    this.fiberLength = state.fields.fiberLength as Float64Array;
    this.fiberVelocity = state.fields.fiberVelocity as Float64Array;
    this.activation = state.fields.activation as Float64Array;
    const out = ctx.write(RENDER_MUSCLE_MESH);
    this.outPosition = out.fields.position as Float64Array;
    this.outNormal = out.fields.normal as Float64Array;
  }

  step(_ctx: ModuleStepContext): void {
    const point = this.point;
    const start = this.pointStart;
    const count = this.pointCount;
    const fiberLength = this.fiberLength;
    const fiberVelocity = this.fiberVelocity;
    const activation = this.activation;
    const outPosition = this.outPosition;
    const outNormal = this.outNormal;
    if (!point || !start || !count || !fiberLength || !fiberVelocity || !activation) return;
    if (!outPosition || !outNormal) return;

    const stride = this.mesh.vertexCount;
    for (let i = 0; i < this.units; i++) {
      // The belly spans the fibers, which are a normalised length: multiplying by the optimal
      // fiber length turns it back into metres along the path.
      const belly = (fiberLength[i] as number) * (this.optimalFiber[i] as number);
      const volume = perfusedVolume(
        this.tissue[i] as number,
        activation[i] as number,
        fiberVelocity[i] as number,
      );

      this.sweepInto(i, belly, volume);

      const at = 3 * i * stride;
      for (let v = 0; v < 3 * stride; v++) {
        outPosition[at + v] = this.mesh.position[v] as number;
        outNormal[at + v] = this.mesh.normal[v] as number;
      }
    }
  }

  /** Sweep one unit into the shared mesh. Split out so `step` reads as what it does. */
  private sweepInto(unit: number, bellyLength: number, volume: number): void {
    const point = this.point as Float64Array;
    const start = this.pointStart as Int32Array;
    const count = this.pointCount as Int32Array;
    // Allocation-free: every buffer this touches was made in the constructor.
    sweepMuscle(
      {
        points: point,
        from: start[unit] as number,
        pointCount: count[unit] as number,
        volume,
        bellyLength,
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
