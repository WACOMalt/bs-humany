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
  Stateful,
} from '@bs-humany/kernel';
import { DelayLine, packState, unpackState } from '@bs-humany/kernel';
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
   * Stretch is a strain: 0.1 is a fibre a tenth longer than its optimal length. Standing still,
   * hardly any muscle is past a set point of 0 -- two of 272 -- and a body on its way down puts
   * 61 of them there, reaching 0.39 at the worst. So a gain of a few turns a real stretch into a
   * few tenths of excitation, and that is the range: measured under a trained policy, 2 is worth
   * 0.64 s upright, 3.5 is worth 0.89, 5 is back to 0.85, and no reflex at all is worth 0.46.
   *
   * The ceiling still matters at the top of that range. The brain above adds its correction to
   * whatever the cord has already put on the muscle, and an excitation clamped at 1 eats it: a
   * reflex that silences the policy is worse than no reflex. That is what the fall-off past 4 is.
   *
   * This used to be five thousandths, and the reason is worth keeping: the length afferent was
   * divided by the optimal fibre length twice, so it read 2.3 to 41 instead of -0.44 to 0, and
   * any gain that was not tiny saturated the whole body. `docs/validation/reflex-gains.md` has
   * the numbers before and after.
   */
  readonly stretch: number;
  /**
   * Group Ia, velocity: excitation a unit of lengthening speed. The damping term.
   *
   * Nearly neutral, and kept anyway. Fibre velocity reaches 0.044 optimal lengths a second in a
   * fall where stretch reaches 0.39, so at any gain comparable to `stretch` this term is small.
   * Measured, it is worth a little to a silent body (0.578 s at 0.5 against 0.573 at 0) and costs
   * a little to a trained one (0.859 s at 0.5 against 0.876 at 0), which is to say it is worth
   * nothing either way at these gains.
   *
   * It is not zero because of what it is for. A length loop with a conduction delay in it rings,
   * and this is the term that stops it: past 2 the ringing is plain -- 0.39 s upright at 4 and
   * 0.27 at 8, against 0.57 with no damping at all -- so the useful range is narrow and below 1.
   * A quarter is inside it with room on both sides.
   */
  readonly velocity: number;
  /**
   * The fibre length the loop holds, as a share of optimal past 1. 0 holds the fibre at its
   * optimal length; a positive set point lets it hang slacker before the reflex answers.
   */
  readonly setPoint: number;
  /**
   * How much of a group's reflex drive subtracts from its antagonist's, 0 to 1.
   *
   * Not tuned by time upright, because that measure cannot choose it: more inhibition means less
   * muscle doing less, and a limper body takes longer to fall. It rises monotonically past every
   * value that means anything -- 0.61 s at 1, 0.65 at 2, 0.68 at 3 -- which is the measure being
   * gamed rather than the reflex being tuned. 1 is the physiological statement, that the
   * antagonist's reflex is fully cancelled; a third of it is what is here, and what chooses
   * between them is a pair of training runs, not a table.
   */
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
  // Hold the fibre at its optimal length. Below this the reflex stops being a reflex: at -0.1,
  // 173 of the body's 272 muscles are past the set point standing perfectly still, so the cord
  // adds a constant tone to most of the body instead of answering a stretch.
  setPoint: 0,
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

export class SpinalModule implements SimModule, Stateful {
  readonly manifest: ModuleManifest;
  private gainsInUse: SpinalGains;
  private readonly stepSeconds: number;
  /** Per unit: its optimal fibre length and the force at which its tendon reads 1. */
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
  /**
   * How many units the cord saw past the set point last tick, and how many it left at full
   * excitation. For display only -- the Spine panel's note -- and so neither is a channel, nothing
   * downstream reads either, and counting them changes no excitation and no trajectory. Plain
   * integers counted in place, so the step still allocates nothing.
   */
  private pastSetPoint = 0;
  private atCeiling = 0;

  constructor(muscles: CompiledMuscleSet, options: SpinalOptions) {
    this.gainsInUse = { ...DEFAULT_SPINAL_GAINS, ...options.gains };
    this.stepSeconds = options.stepSeconds > 0 ? options.stepSeconds : 1 / 500;
    const unitIndex = new Map(muscles.units.map((u, i) => [u.id, i]));
    this.unitCount = muscles.units.length;
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
    this.pastSetPoint = 0;
    this.atCeiling = 0;
  }

  /**
   * The conduction delay's history, for a snapshot: the ring's length in ticks, where it has got
   * to, how much of it is filled, and every afferent in it.
   *
   * Thirty milliseconds of afferents in flight is state the channels do not hold. A restore that
   * emptied the ring had the cord answer the restored body with the oldest value it had -- the
   * body as it was on the first tick after the restore -- for a whole delay, where the captured run
   * was answering the body of thirty milliseconds before. The reflex drive differed, and the run
   * with it.
   */
  getState(): Uint8Array {
    const line = this.line;
    if (!line) return packState([-1, 0, 0]);
    const { ring, head, filled } = line.getState();
    const values = new Float64Array(3 + ring.length);
    values[0] = line.maxDelayTicks;
    values[1] = head;
    values[2] = filled;
    values.set(ring, 3);
    return packState(values);
  }

  /**
   * Put the history back. When the ring is a different size from the one captured -- the delay
   * was changed after the snapshot, or the snapshot is from a body with other muscles -- there is
   * no history of this length to put back, and the cord starts empty, as a restore without this
   * state always did, rather than refusing a session over a slider.
   */
  setState(state: unknown): void {
    const values = unpackState(state, SPINAL_MODULE_ID);
    const line = this.line;
    if (!line) return;
    const ticks = values[0] as number;
    const ringLength = values.length - 3;
    if (ticks !== line.maxDelayTicks || ringLength !== (ticks + 1) * line.width) {
      line.reset();
      return;
    }
    line.setState({
      ring: values.subarray(3),
      head: values[1] as number,
      filled: values[2] as number,
    });
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

  /**
   * Units whose delayed fibre length was past the set point on the last tick: the ones the
   * stretch reflex was answering. Over every unit the cord reads, not per group, so a unit in no
   * group still counts -- it is stretched whether or not anything drives it. Display only.
   */
  get lastPastSetPoint(): number {
    return this.pastSetPoint;
  }

  /**
   * Units at full excitation after the cord added its drive on the last tick. Past this the
   * brain's correction is clamped away (see `SpinalGains.stretch`), which is why a panel shows
   * it. The count is of the total on the efferent, whoever put it there. Display only.
   */
  get lastAtCeiling(): number {
    return this.atCeiling;
  }

  step(_ctx: ModuleStepContext): void {
    const excitation = this.excitation;
    const fibre = this.fibre;
    const line = this.line;
    if (!excitation || !fibre || !line) return;
    const g = this.gainsInUse;
    if (g.stretch === 0 && g.velocity === 0) {
      this.groupDrive.fill(0);
      // A cord that is off answers nothing, so it has nothing past its set point and has put
      // nothing at the ceiling, whatever the brain above it is doing.
      this.pastSetPoint = 0;
      this.atCeiling = 0;
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
      // `muscle.state` publishes this already normalised -- the channel's own word for its unit
      // is "optimal fiber lengths" -- so 1 is a fibre at its optimal length and this is the
      // strain. It used to be divided by the optimal length in metres as well, which turned a
      // signal that runs from -0.44 to 0 into one that runs from 2.3 to 41, so every muscle in
      // the body read as enormously stretched at every instant including standing still. The
      // reflex was not a reflex: it was a constant bias, and one proportional to 1 over the
      // muscle's fibre length, so the shortest-fibred muscles got the most of it. That is why the
      // gain had to be held down at five thousandths to stop it saturating, and why eight tenths
      // put ninety-four per cent of the body's muscles at full excitation.
      const length = (fibre[u] as number) - 1;
      const rate = speed ? (speed[u] as number) : 0;
      const load = pull ? (pull[u] as number) / (this.maxForce[u] as number) : 0;
      this.snapshot[u] = Number.isFinite(length) ? length : 0;
      this.snapshot[n + u] = Number.isFinite(rate) ? rate : 0;
      this.snapshot[2 * n + u] = Number.isFinite(load) ? load : 0;
    }
    line.push(this.snapshot);
    line.read(line.maxDelayTicks, this.delayed);
    // Counted off the delayed afferent, which is the one the reflex below answers, rather than
    // this tick's: the panel says what the cord is doing, and the cord is always a delay behind.
    let past = 0;
    for (let u = 0; u < n; u++) {
      if ((this.delayed[u] as number) - g.setPoint > 0) past += 1;
    }
    this.pastSetPoint = past;

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
    let ceiling = 0;
    for (let u = 0; u < n; u++) {
      if ((excitation[u] as number) >= 1) ceiling += 1;
    }
    this.atCeiling = ceiling;
  }
}
