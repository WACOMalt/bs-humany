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
 * Three reflexes, two of them per unit and one per group. Each unit answers its own spindle and
 * its own tendon organ, on itself and nothing else, which is what a real cord's monosynaptic loop
 * is. The groups -- `reflexGroups()` in `packages/scenarios/src/muscleGroups.ts`, one side of one
 * drive group each, seventy of them -- are where reciprocal inhibition is worked out, because the
 * antagonist table is written between groups and not between muscles. A group is on one side of
 * the body, so a stretched right soleus excites the right soleus only, and inhibits the right
 * shin only.
 *
 * It was not always so, and the history is in the measurements. Until the owner's decision of
 * 2026-09-26 was built, a group held both sides of the body and every term was the group's mean,
 * applied alike to every unit in it: a stretched left soleus excited the right one as much as
 * itself, and a stretched soleus excited tibialis posterior beside it just as much. The gains in
 * `docs/validation/reflex-gains.md` were measured again on this cord, and the page keeps the
 * pooled cord's numbers beside them.
 *
 * **The stretch reflex.** A unit past its set point is excited in proportion to how far past it
 * is -- the spindle's group II, length-sensitive -- and in proportion to how fast it is being
 * pulled -- group Ia, velocity-sensitive. The velocity term is the damping, and it is the one that
 * stops a pure length loop from ringing. Only lengthening excites: a shortening muscle is not
 * resisted by its own spindle.
 *
 * **Reciprocal inhibition**, per antagonist pair of groups on one side. The Ia afferent that
 * excites a muscle also inhibits its opposite through an interneuron, so a stretched muscle does
 * not fight its own antagonist's tone. Without it the two halves of every pair co-contract and the
 * joint stiffens into uselessness. A group's inhibitory drive is the mean of its units' own reflex
 * drives, and a share of it (`SpinalGains.inhibition`) comes off every unit of the group opposite.
 * The mean, rather than a unit-to-unit table, because there is no such table: the pairing is by
 * what a group does to a joint, and one interneuron pool per side of a joint is as fine as it goes.
 *
 * **Autogenic inhibition**, from the Golgi tendon organ's Ib. A unit's tendon load past a ceiling
 * subtracts from that unit's own drive. It is what keeps a reflex from tearing its own tendon off
 * the bone, and the reason a loop can be stable under a load it cannot lift. It is a safety limit
 * that has not been seen to fire: at the default ceiling of 1.2 it never does, because tendon load
 * peaks near a quarter of maximum isometric force even in a full collapse (0.235, measured once
 * ba50a95 fixed the length afferent; reflex-gains.md).
 *
 * A unit in no group is not wired to the cord at all, and the cord leaves it alone. Every unit in
 * the body is in exactly one group of the table `reflexGroups()` builds, so that is a statement
 * about a caller's partial table -- a test's ankle, say -- and not about the body.
 *
 * **Stretch and velocity both at 0 switch the whole cord off**, Ib included: the step returns
 * before it reads a single afferent. A Golgi term on its own could still take drive off a loaded
 * unit, as a real one would, but off is meant to be a body with no cord -- what every checkpoint
 * before this module was trained in -- and the ceiling is not reached in anything measured, so
 * nothing is lost by it today. `SPINAL_OFF` is that cord and is what a bare module runs; the
 * measured one is `MEASURED_SPINAL_GAINS`. Switched back on, the cord empties its delay line
 * first, because a cord that is off takes no afferents in and its line still holds the body as it
 * was when it went off.
 *
 * Everything is delayed. `delaySeconds` is the conduction time from the spindle to the cord and
 * back, and the specification is blunt about why it may not be skipped: "neural conduction delay
 * is a first-order determinant of whether a nerve module produces realistic behavior or an
 * oscillating mess". The value is `SPINAL_CONDUCTION_DELAY_S`, chosen rather than sourced
 * (OQ-031). The afferents are pushed into a `DelayLine` every tick and read back from
 * `delaySeconds` ago, so the reflex answers the body as it was, not as it is -- which is the only
 * regime a real cord ever works in, and the regime a policy trained above this layer had better
 * learn in too.
 *
 * It adds onto `efferent.alphaMotor` like every other driver, so a zero gain changes nothing. It
 * runs last of the loop's three writers in the `control` phase: the tremor, then the nerves, then
 * this, because none of them declares a dependency on another and the kernel breaks the tie by
 * module id (`motor-noise` < `nerves` < `spinal`). Each writer adds and clamps to [0, 1] in turn,
 * so the cord's drive lands on top of what the brain has already asked for, and the order decides
 * what each clamp eats; `SpinalGains.stretch` says what that costs the brain. A test pins the
 * order.
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
 * A group of units the cord inhibits together, and the group that opposes it. The pairing comes
 * from the caller because the group table lives above this package; `antagonist` naming a group
 * that was not given is ignored rather than refused, so a partial table still works. Groups are
 * meant not to overlap: a unit in two of them answers its own spindle once and is inhibited by
 * both groups' antagonists.
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
   * few tenths of excitation, and that is the range. Measured under a trained policy on this cord,
   * a unit answering its own spindle, 2 is worth 0.73 s upright, 3.5 is worth 0.82 and 5 is worth
   * 0.85, against 0.46 with no reflex at all.
   *
   * The ceiling still matters at the top of that range. The cord runs after the brain in the
   * control phase (see the header), so it adds its drive on top of the correction the brain has
   * just made and clamps the total at 1. Once the cord alone is enough to take a unit to the
   * ceiling, whatever the brain asked of that unit, up or down, is clamped away: a reflex that
   * silences the policy is worse than no reflex. On the pooled cord this replaced, where a group's
   * mean drove every unit in it and both legs together, that was a fall-off past 4 -- 0.89 s at
   * 3.5, 0.90 at 4, 0.85 at 5 -- and 3.5 was chosen on it. Per unit the cord drives less of the
   * body at any gain and the fall-off has not been reached by 5, the top of the sweep; 3.5 stays
   * until a sweep past 5, under a policy trained over this cord, finds where it is
   * (reflex-gains.md). (A correction that would take a unit below 0 is lost earlier, at the
   * brain's own clamp, before the cord adds anything.)
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
   * The speed is `muscle.state`'s `fiberVelocity`, which is a fraction of the unit's maximum
   * contraction velocity, not optimal lengths a second; that maximum is 10 optimal lengths a
   * second for every unit in the body today, so 0.1 here is a fibre lengthening at one optimal
   * length a second.
   *
   * Small, and worth having. Fibre velocity reaches 0.044 of that maximum in a fall -- about 0.44
   * optimal lengths a second -- where stretch reaches 0.39, so at any gain comparable to `stretch`
   * this term is small. Measured at stretch 3, it is worth 0.04 s upright to a silent body (0.611
   * at 0.5 against 0.575 at 0) and as much to a trained one (0.800 against 0.761). On the pooled
   * cord, where a unit's speed was averaged over a group mostly not moving, it was worth nothing
   * either way (0.578 against 0.573 silent, 0.859 against 0.876 trained).
   *
   * What it is for sets the top of it. A length loop with a conduction delay in it rings, and this
   * is the term that stops it; past 2 the ringing is plain -- 0.37 s upright at 4 and 0.18 at 8,
   * against 0.58 with no damping at all -- so the useful range is narrow and below 2. A quarter is
   * inside it with room on both sides.
   */
  readonly velocity: number;
  /**
   * The fibre length the loop holds, as a share of optimal past 1. 0 holds the fibre at its
   * optimal length; a positive set point lets it hang slacker before the reflex answers.
   */
  readonly setPoint: number;
  /**
   * How much of a group's mean reflex drive comes off every unit of its antagonist on the same
   * side, 0 to 1.
   *
   * Not tuned by time upright, because that measure cannot choose it: more inhibition means less
   * muscle doing less, and a limper body takes longer to fall. It rises monotonically past every
   * value that means anything -- 0.66 s at 1, 0.68 at 1.5, 0.73 at 3 -- which is the measure being
   * gamed rather than the reflex being tuned. 1 is the physiological statement, that the
   * antagonist's reflex is fully cancelled; a third of it is what is here, and what chooses
   * between them is a pair of training runs, not a table.
   */
  readonly inhibition: number;
  /** Ib: tendon load, as a share of maximum isometric force, above which the unit inhibits itself. */
  readonly forceCeiling: number;
  /** How hard that inhibition pulls, per unit of load past the ceiling. */
  readonly forceInhibition: number;
  /** Seconds from the spindle to the cord and back; `SPINAL_CONDUCTION_DELAY_S` unless set. */
  readonly delaySeconds: number;
}

/**
 * The cord's conduction delay: seconds from the spindle to the cord and back, one number for
 * every reflex group.
 *
 * Chosen, not sourced (OQ-031, `docs/sources/open-questions.md`). Thirty milliseconds is the
 * order of a short-latency stretch reflex in the leg, and it is what every measurement in
 * `docs/validation/reflex-gains.md` was taken at, so it is the delay the measured gains are
 * measured for; but no primary source for the latency is in the bibliography, and a real cord's
 * delay differs by pathway, where this one is the same for every group. When a source is found,
 * its citation belongs beside this constant and never inside `SpinalGains`, which is saved with
 * every checkpoint: a checkpoint records the number it was trained at, not where it came from.
 */
export const SPINAL_CONDUCTION_DELAY_S = 0.03;

/**
 * The cord as measured: the gains a run gets unless it says otherwise, and the one the owner has
 * decided the studio and the scripted scenarios will run with. Every number is from
 * `docs/validation/reflex-gains.md`, which has the tables and how to reproduce them;
 * `SpinalGains` says what each one is. They were chosen on the pooled cord and measured again on
 * the cord per side and per unit; the second sweep moved none of them (`SpinalGains.stretch` says
 * why the stretch gain stays where it is).
 *
 * The training recipe (`tools/train/src/recipe.ts`) keeps its own copy of these as
 * `DEFAULT_REFLEX`, because it loads without this package; a test here holds the two together
 * field by field.
 */
export const MEASURED_SPINAL_GAINS: SpinalGains = {
  stretch: 3.5,
  velocity: 0.25,
  // Hold the fibre at its optimal length. Below this the reflex stops being a reflex: at -0.1,
  // 173 of the body's 272 muscles are past the set point standing perfectly still, so the cord
  // adds a constant tone to most of the body instead of answering a stretch.
  setPoint: 0,
  inhibition: 0.3,
  forceCeiling: 1.2,
  forceInhibition: 0.5,
  delaySeconds: SPINAL_CONDUCTION_DELAY_S,
};

/**
 * The cord switched off: the measured cord with both spindle gains at zero, which turns the
 * whole of it off, Golgi term included (see the header). The other five numbers are the measured
 * ones so that turning the stretch up from off gives the measured cord's inhibition, ceiling and
 * delay, not a second set of them. The recipe's `NO_REFLEX` is the same seven numbers.
 */
export const SPINAL_OFF: SpinalGains = { ...MEASURED_SPINAL_GAINS, stretch: 0, velocity: 0 };

/**
 * What a module built without gains runs: off. A bare cord changes nothing, so adding the module
 * to a kernel is not by itself a change of behaviour, and a host that wants the reflexes asks for
 * `MEASURED_SPINAL_GAINS` by name.
 */
export const DEFAULT_SPINAL_GAINS: SpinalGains = SPINAL_OFF;

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
  /** Per unit: the force at which its tendon reads 1 (maximum isometric force). */
  private readonly maxForce: Float64Array;
  /** Per group: the unit indices in it, and the index of the group that opposes it. */
  private readonly groupUnits: Int32Array[];
  private readonly groupIds: readonly string[];
  private readonly opposes: Int32Array;
  /** Every unit in at least one group, once each: the units the cord is wired to. */
  private readonly wired: Int32Array;
  /**
   * Per unit, this tick: first its own reflex drive, from its own spindle and tendon organ, then
   * that less what its group's antagonist takes off -- the amount added to its excitation.
   */
  private readonly unitDrive: Float64Array;
  /** The mean of each group's units' own reflex drives this tick, before inhibition. */
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
    this.wired = Int32Array.from(new Set(this.groupUnits.flatMap((units) => Array.from(units))));
    this.unitDrive = new Float64Array(this.unitCount);
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

  /**
   * Take new gains. Switching the cord on from off empties the delay line: an off cord takes no
   * afferents in, so its line still holds the body as it was when the cord went off, and reading
   * that back for a whole conduction delay would answer a body that has since moved. Empty, the
   * line hands back the one afferent it has, so the first tick on answers the body as it is,
   * exactly as the first tick of an episode does. Here rather than in `step`, and `reset` fills a
   * ring that already exists, so the step still allocates nothing.
   */
  set gains(next: SpinalGains) {
    const wasOff = SpinalModule.isOff(this.gainsInUse);
    this.gainsInUse = next;
    this.rebuildLine();
    if (wasOff && !SpinalModule.isOff(next)) this.line?.reset();
  }

  /** Both spindle gains at zero is the whole cord off, the Golgi term with it (see the header). */
  private static isOff(g: SpinalGains): boolean {
    return g.stretch === 0 && g.velocity === 0;
  }

  /** Change some gains and keep the rest. */
  adjust(next: Partial<SpinalGains>): void {
    this.gains = { ...this.gainsInUse, ...next };
  }

  /**
   * Per group, the mean of its units' own reflex drives as of the last tick, before reciprocal
   * inhibition -- what the group sends its antagonist -- for a panel to draw. In the order of the
   * groups the cord was given, which for `reflexGroups()` is the order of the policy's outputs.
   */
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
    if (SpinalModule.isOff(g)) {
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

    // Each wired unit's own drive: its stretch reflex, less what its own Golgi organ takes back.
    // Per unit, because the monosynaptic loop is a muscle answering its own spindle; a unit the
    // cord is not wired to keeps a drive of zero, which the constructor's fill left it at.
    const wired = this.wired;
    const unitDrive = this.unitDrive;
    for (let k = 0; k < wired.length; k++) {
      const u = wired[k] as number;
      const stretch = (this.delayed[u] as number) - g.setPoint;
      const rate = this.delayed[n + u] as number;
      const load = this.delayed[2 * n + u] as number;
      // Only a lengthening muscle is excited by its own spindle.
      let drive = 0;
      if (stretch > 0) drive += g.stretch * stretch;
      if (rate > 0) drive += g.velocity * rate;
      // Ib: past the ceiling the organ takes drive back off, and can drive it negative.
      if (load > g.forceCeiling) drive -= g.forceInhibition * (load - g.forceCeiling);
      unitDrive[u] = drive;
    }

    // Each group's drive, the mean of its units' own, which is what its interneurons carry to the
    // antagonist. All of these are taken before any inhibition is subtracted, so a pair inhibit
    // each other symmetrically rather than in the order the groups happen to sit.
    for (let gi = 0; gi < this.groupUnits.length; gi++) {
      const units = this.groupUnits[gi] as Int32Array;
      let sum = 0;
      for (let k = 0; k < units.length; k++) sum += unitDrive[units[k] as number] as number;
      this.groupDrive[gi] = units.length ? sum / units.length : 0;
    }

    // Reciprocal inhibition: a share of the antagonist group's excitatory drive off every unit of
    // this one. Taken off the per-unit drive in place, now that every group's mean is known.
    for (let gi = 0; gi < this.groupUnits.length; gi++) {
      const against = this.opposes[gi] as number;
      if (against < 0) continue;
      const theirs = this.groupDrive[against] as number;
      if (theirs <= 0) continue;
      const taken = g.inhibition * theirs;
      const units = this.groupUnits[gi] as Int32Array;
      for (let k = 0; k < units.length; k++) {
        const u = units[k] as number;
        unitDrive[u] = (unitDrive[u] as number) - taken;
      }
    }

    // And onto the efferent, once per unit, clamped to what a motor neuron can be asked for.
    for (let k = 0; k < wired.length; k++) {
      const u = wired[k] as number;
      const value = (excitation[u] as number) + (unitDrive[u] as number);
      excitation[u] = value < 0 ? 0 : value > 1 ? 1 : value;
    }
    let ceiling = 0;
    for (let u = 0; u < n; u++) {
      if ((excitation[u] as number) >= 1) ceiling += 1;
    }
    this.atCeiling = ceiling;
  }
}
