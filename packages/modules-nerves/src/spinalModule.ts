/**
 * `SpinalModule` -- the reflex arc, under the brain.
 *
 * Section 14.1 of the specification calls the spinal loops "the natural first target: they are
 * closed loops entirely within `sense` -> `control` -> `actuate`, need no brain, and produce
 * immediately visible, verifiable behavior". This is that layer, and the reason it comes before
 * any more training is that standing is mostly not a learned skill. A real body is held up by
 * intrinsic muscle stiffness and a loop through the cord that never reaches the brain at all;
 * what the brain adds is slow, and it is added on top of a body that is already roughly upright.
 * Without this layer a search has to discover the whole stabilising feedback law from scratch,
 * which is what nine hundred generations of not standing looks like.
 *
 * Three reflexes, all of them local:
 *
 * **The stretch reflex**, monosynaptic and per unit. A muscle pulled past its set point excites
 * itself in proportion to how far past it is -- the spindle's group II, length-sensitive -- and
 * in proportion to how fast it is being pulled -- group Ia, velocity-sensitive. The velocity
 * term is the damping, and it is the one that stops a pure length loop from ringing. Only
 * lengthening excites: a shortening muscle is not resisted by its own spindle.
 *
 * **Reciprocal inhibition**, per antagonist pair. The Ia afferent that excites a muscle also
 * inhibits its opposite through an interneuron, so a stretched muscle does not fight its own
 * antagonist's tone. Without it the two halves of every pair co-contract and the joint stiffens
 * into uselessness.
 *
 * **Autogenic inhibition**, per unit, from the Golgi tendon organ's Ib. Force past a ceiling
 * subtracts from the muscle's own drive. It is what keeps a reflex from tearing its own tendon
 * off the bone, and it is the reason the loop is stable under a load it cannot lift.
 *
 * Everything is delayed. `delaySeconds` is the conduction time from the spindle to the cord and
 * back, and the specification is blunt about why it may not be skipped: "neural conduction delay
 * is a first-order determinant of whether a nerve module produces realistic behavior or an
 * oscillating mess". A monosynaptic loop in a human leg is about thirty milliseconds. The
 * afferents are pushed into a `DelayLine` every tick and read back from `delaySeconds` ago, so
 * the reflex answers the body as it was, not as it is -- which is the only regime a real cord
 * ever works in, and the regime a policy trained above this layer had better learn in too.
 *
 * It adds onto `efferent.alphaMotor` like every other driver, so a zero gain changes nothing and
 * the brain above it keeps whatever authority it was given.
 */

import type {
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { DelayLine } from '@bs-humany/kernel';
import {
  type CompiledMuscleSet,
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_CHANNEL_VERSION,
  MUSCLE_STATE,
} from '@bs-humany/modules-muscle';

export const SPINAL_MODULE_ID = 'bsums.xyz.bs-humany.spinal';

/**
 * A group of units the cord treats together, and the group that opposes it. The pairing comes
 * from the caller because the group table lives above this package; `antagonist` naming a group
 * that was not given is ignored rather than refused, so a partial table still works.
 */
export interface ReflexGroup {
  readonly id: string;
  readonly units: readonly string[];
  readonly antagonist?: string | undefined;
}

export interface SpinalGains {
  /**
   * Group II, length: excitation a unit of stretch past the set point. 0 is no reflex.
   *
   * Small, and it has to be. Fibre stretch is measured in whole optimal lengths, so a gain near
   * one drives every muscle to the excitation ceiling within a tick and the body becomes a
   * rigid statue -- which survives a little longer than a slack one and is useless, because the
   * brain above adds its correction to an excitation already clamped at 1 and the clamp eats it.
   * A reflex that silences the policy is worse than no reflex. Measured on the reference body:
   * 0.005 puts about five percent excitation on a resting muscle with nothing at the ceiling,
   * and 0.04 begins to saturate. See `tools/train/runs/cordlevel.mjs`.
   */
  readonly stretch: number;
  /**
   * Group Ia, velocity: excitation a unit of lengthening speed. The damping term.
   *
   * Scaled quite differently from `stretch`, because fibre velocity in optimal lengths a second
   * is a much smaller number than fibre stretch in optimal lengths. It does nothing below about
   * 0.1 and saturates past about 3; at 1 it is worth roughly a third more time upright than the
   * length term alone, which is what a damping term is supposed to be worth.
   */
  readonly velocity: number;
  /**
   * The fibre length the loop holds, as a share of optimal past 1. 0 holds the fibre at its
   * optimal length; a positive set point lets it hang slacker before the reflex answers.
   */
  readonly setPoint: number;
  /** How much of a group's reflex drive subtracts from its antagonist's, 0 to 1. */
  readonly inhibition: number;
  /** Ib: tendon load, as a share of maximum isometric force, above which the unit inhibits itself. */
  readonly forceCeiling: number;
  /** How hard that inhibition pulls, per unit of load past the ceiling. */
  readonly forceInhibition: number;
  /** Seconds from the spindle to the cord and back. About 0.03 in a human leg. */
  readonly delaySeconds: number;
}

export const DEFAULT_SPINAL_GAINS: SpinalGains = {
  stretch: 0,
  velocity: 0,
  setPoint: -0.1,
  inhibition: 0.3,
  forceCeiling: 1.2,
  forceInhibition: 0.5,
  delaySeconds: 0.03,
};

export interface SpinalOptions {
  readonly groups: readonly ReflexGroup[];
  readonly gains?: Partial<SpinalGains>;
  /** The tick length, to turn the conduction delay into ticks. */
  readonly stepSeconds: number;
}

export class SpinalModule implements SimModule {
  readonly manifest: ModuleManifest;
  private gainsInUse: SpinalGains;
  private readonly stepSeconds: number;
  /** Per unit: its optimal fibre length and the force at which its tendon reads 1. */
  private readonly optimal: Float64Array;
  private readonly maxForce: Float64Array;
  /** Per group: the unit indices in it, and the index of the group that opposes it. */
  private readonly groupUnits: Int32Array[];
  private readonly groupIds: readonly string[];
  private readonly opposes: Int32Array;
  /** The reflex drive each group worked out this tick, before inhibition. */
  private readonly groupDrive: Float64Array;
  private readonly unitCount: number;

  private excitation: Float64Array | undefined;
  private fibre: Float64Array | undefined;
  private speed: Float64Array | undefined;
  private pull: Float64Array | undefined;
  /** The afferents, delayed: length, velocity and force per unit, in one snapshot. */
  private line: DelayLine | undefined;
  private readonly snapshot: Float64Array;
  private readonly delayed: Float64Array;

  constructor(muscles: CompiledMuscleSet, options: SpinalOptions) {
    this.gainsInUse = { ...DEFAULT_SPINAL_GAINS, ...options.gains };
    this.stepSeconds = options.stepSeconds > 0 ? options.stepSeconds : 1 / 500;
    const unitIndex = new Map(muscles.units.map((u, i) => [u.id, i]));
    this.unitCount = muscles.units.length;
    this.optimal = Float64Array.from(muscles.units, (u) => u.parameters.optimalFiberLength || 0.1);
    this.maxForce = Float64Array.from(muscles.units, (u) => u.parameters.maxIsometricForce || 1);
    this.groupIds = options.groups.map((g) => g.id);
    this.groupUnits = options.groups.map((g) =>
      Int32Array.from(g.units.map((id) => unitIndex.get(id) ?? -1).filter((i) => i >= 0)),
    );
    const at = new Map(this.groupIds.map((id, i) => [id, i]));
    this.opposes = Int32Array.from(options.groups, (g) =>
      g.antagonist === undefined ? -1 : (at.get(g.antagonist) ?? -1),
    );
    this.groupDrive = new Float64Array(options.groups.length);
    this.snapshot = new Float64Array(3 * this.unitCount);
    this.delayed = new Float64Array(3 * this.unitCount);
    this.manifest = {
      id: SPINAL_MODULE_ID,
      version: '1.0.0',
      phase: 'control',
      dependsOn: [],
      reads: [{ id: MUSCLE_STATE, version: MUSCLE_CHANNEL_VERSION }],
      writes: [],
      accumulates: [{ id: EFFERENT_ALPHA_MOTOR, version: MUSCLE_CHANNEL_VERSION }],
      gives: [],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
    this.line?.reset();
  }

  private bind(ctx: ModuleInitContext): void {
    const state = ctx.read(MUSCLE_STATE);
    this.fibre = state.fields.fiberLength as Float64Array;
    this.speed = state.fields.fiberVelocity as Float64Array | undefined;
    this.pull = state.fields.tendonForce as Float64Array | undefined;
    this.excitation = ctx.accumulate(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;
    this.rebuildLine();
  }

  /** The ring is sized by the longest delay the gains ask for; a change in delay rebuilds it. */
  private rebuildLine(): void {
    const ticks = Math.max(0, Math.round(this.gainsInUse.delaySeconds / this.stepSeconds));
    if (this.line && this.line.maxDelayTicks === ticks) return;
    this.line = new DelayLine(3 * this.unitCount, ticks);
  }

  get gains(): SpinalGains {
    return this.gainsInUse;
  }

  set gains(next: SpinalGains) {
    this.gainsInUse = next;
    this.rebuildLine();
  }

  /** Change some gains and keep the rest. */
  adjust(next: Partial<SpinalGains>): void {
    this.gains = { ...this.gainsInUse, ...next };
  }

  /** The reflex drive per group as of the last tick, for a panel to draw. */
  get lastDrive(): Float64Array {
    return this.groupDrive;
  }

  get groups(): readonly string[] {
    return this.groupIds;
  }

  step(_ctx: ModuleStepContext): void {
    const excitation = this.excitation;
    const fibre = this.fibre;
    const line = this.line;
    if (!excitation || !fibre || !line) return;
    const g = this.gainsInUse;
    if (g.stretch === 0 && g.velocity === 0) {
      this.groupDrive.fill(0);
      return;
    }

    // Take this tick's afferents and read back the ones from a conduction delay ago. Before the
    // ring has filled -- the first thirty milliseconds of an episode -- the line hands back the
    // oldest value it has rather than a zero, which is its own documented choice and the right
    // one: a cord with nothing to react to yet should be quiet, not startled.
    const speed = this.speed;
    const pull = this.pull;
    const n = this.unitCount;
    for (let u = 0; u < n; u++) {
      const length = (fibre[u] as number) / (this.optimal[u] as number) - 1;
      const rate = speed ? (speed[u] as number) : 0;
      const load = pull ? (pull[u] as number) / (this.maxForce[u] as number) : 0;
      this.snapshot[u] = Number.isFinite(length) ? length : 0;
      this.snapshot[n + u] = Number.isFinite(rate) ? rate : 0;
      this.snapshot[2 * n + u] = Number.isFinite(load) ? load : 0;
    }
    line.push(this.snapshot);
    line.read(line.maxDelayTicks, this.delayed);

    // Each group's drive: the mean over its units of the stretch reflex, less what the Golgi
    // organ takes back. Worked per group because that is the dimension the antagonist table is
    // in, and applied per unit because that is where excitation lives.
    for (let gi = 0; gi < this.groupUnits.length; gi++) {
      const units = this.groupUnits[gi] as Int32Array;
      let sum = 0;
      for (let k = 0; k < units.length; k++) {
        const u = units[k] as number;
        const stretch = (this.delayed[u] as number) - g.setPoint;
        const rate = this.delayed[n + u] as number;
        const load = this.delayed[2 * n + u] as number;
        // Only a lengthening muscle is excited by its own spindle.
        let drive = 0;
        if (stretch > 0) drive += g.stretch * stretch;
        if (rate > 0) drive += g.velocity * rate;
        // Ib: past the ceiling the organ takes drive back off, and can drive it negative.
        if (load > g.forceCeiling) drive -= g.forceInhibition * (load - g.forceCeiling);
        sum += drive;
      }
      this.groupDrive[gi] = units.length ? sum / units.length : 0;
    }

    // Reciprocal inhibition, from the drive as it stood before any of it was subtracted, so the
    // pair inhibit each other symmetrically rather than in the order the groups happen to sit.
    for (let gi = 0; gi < this.groupUnits.length; gi++) {
      const against = this.opposes[gi] as number;
      const mine = this.groupDrive[gi] as number;
      const theirs = against >= 0 ? (this.groupDrive[against] as number) : 0;
      const net = mine - g.inhibition * Math.max(0, theirs);
      const units = this.groupUnits[gi] as Int32Array;
      for (let k = 0; k < units.length; k++) {
        const u = units[k] as number;
        const value = (excitation[u] as number) + net;
        excitation[u] = value < 0 ? 0 : value > 1 ? 1 : value;
      }
    }
  }
}
