/**
 * `MuscleTestDriveModule` -- ticket N3.3, muscle spec section 10.2.
 *
 * Something has to excite the muscles until there are nerves to do it. This is that something: a
 * pattern generator that writes `efferent.alphaMotor` and nothing else, so that the day a nerve
 * module arrives it takes over the same accumulator and this module is simply not registered.
 *
 * It is also the only way to exercise `muscle.dynamics` at all, and that is not an accident of
 * testing -- it is the accumulator contract working as designed. The kernel zeroes accumulators at
 * the top of every tick, precisely so that a writer which stops writing stops contributing rather
 * than leaving its last value stuck on. A test that poked the buffer from outside the tick would
 * be wiped, and rightly: drive is something a module supplies every tick or not at all.
 *
 * ## Four patterns, and why these four
 *
 * `constant` holds a muscle at a level, which is what a benchmark needs. `sine` sweeps it, which
 * is what shows a lag. `step` turns it on at a moment, which is what shows the activation time
 * constant. `scripted` plays a list of breakpoints, which is what a scenario file needs to
 * reproduce a movement. Between them they cover every way this module is asked to be used before
 * a controller exists, and none of them reads a clock: time is `ctx.simTime`, so a run repeats.
 */

import type {
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { EFFERENT_ALPHA_MOTOR, MUSCLE_CHANNEL_VERSION } from './channels.js';
import type { CompiledMuscleSet } from './compile.js';

export const MUSCLE_TEST_DRIVE_MODULE_ID = 'bsums.xyz.bs-humany.muscle.testDrive';

export type DrivePattern =
  | { readonly kind: 'constant'; readonly level: number }
  /** `mean + amplitude * sin(2 pi f t)`, clamped into range. */
  | {
      readonly kind: 'sine';
      readonly mean: number;
      readonly amplitude: number;
      readonly frequency: number;
    }
  /** `before` until `at` seconds of simulated time, `after` from then on. */
  | {
      readonly kind: 'step';
      readonly at: number;
      readonly before: number;
      readonly after: number;
    }
  /** Breakpoints in simulated seconds, linearly interpolated, held flat outside the range. */
  | {
      readonly kind: 'scripted';
      readonly points: readonly { readonly time: number; readonly level: number }[];
    };

export interface DriveAssignment {
  /** Unit ids, or every unit in the set. */
  readonly units: readonly string[] | 'all';
  readonly pattern: DrivePattern;
}

const KIND = { constant: 0, sine: 1, step: 2, scripted: 3 } as const;

export class MuscleTestDriveModule implements SimModule {
  readonly manifest: ModuleManifest;

  private readonly units: number;
  /**
   * The pattern for each unit, flattened.
   *
   * `kind` selects the branch and `a`, `b`, `c` mean whatever that branch needs: the level for a
   * constant, mean/amplitude/frequency for a sine, at/before/after for a step, and for a scripted
   * pattern the offset and count into the breakpoint arrays. Four small arrays rather than an
   * array of objects, because `step` walks all of them every tick.
   */
  private readonly kind: Int32Array;
  private readonly a: Float64Array;
  private readonly b: Float64Array;
  private readonly c: Float64Array;
  private readonly scriptTime: Float64Array;
  private readonly scriptLevel: Float64Array;
  /**
   * A level set from outside, per unit, or NaN where the unit's pattern still applies.
   *
   * This is what a slider talks to. A pattern is fixed when the module is built, which is right
   * for a benchmark and useless for a person turning a muscle on to see what happens -- and
   * turning a muscle on to see what happens is exactly what this module is for until nerves
   * exist. Held as numbers rather than a map so `step` stays allocation-free.
   */
  private readonly overrideLevel: Float64Array;
  /** The scenario script's layer of `setOverride`; `scriptLevel` above is the scripted pattern's points. */
  private readonly scriptDrive: Float64Array;
  private readonly indexOf: Map<string, number>;

  private excitation: Float64Array | undefined;

  constructor(
    readonly muscles: CompiledMuscleSet,
    assignments: readonly DriveAssignment[],
  ) {
    const n = muscles.units.length;
    this.units = n;
    this.kind = new Int32Array(n);
    this.a = new Float64Array(n);
    this.b = new Float64Array(n);
    this.c = new Float64Array(n);

    const index = new Map(muscles.units.map((u, i) => [u.id, i]));
    this.indexOf = index;
    this.overrideLevel = new Float64Array(n).fill(Number.NaN);
    this.scriptDrive = new Float64Array(n).fill(Number.NaN);
    const times: number[] = [];
    const levels: number[] = [];

    for (const assignment of assignments) {
      const targets =
        assignment.units === 'all'
          ? muscles.units.map((_, i) => i)
          : assignment.units.map((id) => {
              const found = index.get(id);
              if (found === undefined) {
                throw new Error(
                  `MuscleTestDriveModule was given a pattern for unit '${id}', which is not in ` +
                    'this muscle set. Check the id against the compiled set.',
                );
              }
              return found;
            });

      const p = assignment.pattern;
      // A scripted pattern's breakpoints are appended once and shared by every unit assigned it.
      let offset = 0;
      let count = 0;
      if (p.kind === 'scripted') {
        if (p.points.length === 0) throw new Error('A scripted drive pattern needs a breakpoint.');
        offset = times.length;
        count = p.points.length;
        for (const point of p.points) {
          times.push(point.time);
          levels.push(point.level);
        }
      }

      for (const unit of targets) {
        this.kind[unit] = KIND[p.kind];
        if (p.kind === 'constant') {
          this.a[unit] = p.level;
        } else if (p.kind === 'sine') {
          this.a[unit] = p.mean;
          this.b[unit] = p.amplitude;
          this.c[unit] = p.frequency;
        } else if (p.kind === 'step') {
          this.a[unit] = p.at;
          this.b[unit] = p.before;
          this.c[unit] = p.after;
        } else {
          this.a[unit] = offset;
          this.b[unit] = count;
        }
      }
    }

    this.scriptTime = Float64Array.from(times);
    this.scriptLevel = Float64Array.from(levels);

    this.manifest = {
      id: MUSCLE_TEST_DRIVE_MODULE_ID,
      version: '1.0.0',
      // Before anything acts on it, and before the solve.
      phase: 'input',
      dependsOn: [],
      reads: [],
      writes: [],
      accumulates: [{ id: EFFERENT_ALPHA_MOTOR, version: MUSCLE_CHANNEL_VERSION }],
      // Declared by `muscle.dynamics`, not here. A channel has exactly one provider, and the
      // provider should be the module that exists in every configuration which uses the channel:
      // drive with nothing to drive is meaningless, whereas muscles with no drive are just
      // relaxed muscles. So this module is a writer into somebody else's accumulator, which is
      // also precisely the position a nerve module will be in.
      gives: [],
    };
  }

  /**
   * Drive one unit at a level of your choosing, or hand it back to its pattern with `null`.
   *
   * Takes effect on the next tick and needs no restart, because the drive is recomputed every
   * tick from scratch -- the accumulator is zeroed at the top of each one, so there is no stale
   * value to clear.
   */
  /**
   * Drive a unit from outside its pattern. Two layers, because two things do this and they used
   * to fight: a scenario's script, which sets its postural tone every tick, and a person's
   * slider, which the script then overwrote on the next tick for exactly the units it toned --
   * the ankle, the trunk, the hip -- while every other slider worked. The `script` layer is the
   * scenario's; the default layer is the person's; the unit gets the larger of the two, so a
   * slider at zero leaves the tone alone and a slider raised adds to it.
   */
  setOverride(unitId: string, level: number | null, layer: 'user' | 'script' = 'user'): void {
    const at = this.indexOf.get(unitId);
    if (at === undefined) {
      throw new Error(`No muscle unit '${unitId}' in this set.`);
    }
    const store = layer === 'script' ? this.scriptDrive : this.overrideLevel;
    store[at] = level === null ? Number.NaN : level;
  }

  /** The level a unit is being driven at from outside, or null where its pattern still applies. */
  overrideFor(unitId: string): number | null {
    const at = this.indexOf.get(unitId);
    if (at === undefined) return null;
    const level = this.effectiveOverride(at);
    return Number.isNaN(level) ? null : level;
  }

  /** The larger of the two layers, or NaN when neither is set. */
  private effectiveOverride(at: number): number {
    const user = this.overrideLevel[at] as number;
    const script = this.scriptDrive[at] as number;
    if (Number.isNaN(user)) return script;
    if (Number.isNaN(script)) return user;
    return Math.max(user, script);
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  private bind(ctx: ModuleInitContext): void {
    this.excitation = ctx.accumulate(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;
  }

  step(ctx: ModuleStepContext): void {
    const excitation = this.excitation;
    if (!excitation) return;
    const time = ctx.simTime;

    for (let i = 0; i < this.units; i++) {
      let level: number;
      const forced = this.effectiveOverride(i);
      if (!Number.isNaN(forced)) {
        excitation[i] = (excitation[i] as number) + (forced < 0 ? 0 : forced > 1 ? 1 : forced);
        continue;
      }
      switch (this.kind[i]) {
        case KIND.sine:
          level =
            (this.a[i] as number) +
            (this.b[i] as number) * Math.sin(2 * Math.PI * (this.c[i] as number) * time);
          break;
        case KIND.step:
          level = time < (this.a[i] as number) ? (this.b[i] as number) : (this.c[i] as number);
          break;
        case KIND.scripted:
          level = this.scripted(this.a[i] as number, this.b[i] as number, time);
          break;
        default:
          level = this.a[i] as number;
      }
      // An accumulator, so this adds to whatever else is driving. Clamping happens here rather
      // than in the muscle so that a pattern cannot smuggle an out-of-range excitation past a
      // second writer's contribution.
      excitation[i] = (excitation[i] as number) + (level < 0 ? 0 : level > 1 ? 1 : level);
    }
  }

  /** Linear between breakpoints, flat outside them. Held flat rather than extrapolated: a script
   * that ends does not keep ramping. */
  private scripted(offset: number, count: number, time: number): number {
    const last = offset + count - 1;
    if (time <= (this.scriptTime[offset] as number)) return this.scriptLevel[offset] as number;
    if (time >= (this.scriptTime[last] as number)) return this.scriptLevel[last] as number;
    for (let i = offset; i < last; i++) {
      const t0 = this.scriptTime[i] as number;
      const t1 = this.scriptTime[i + 1] as number;
      if (time > t1) continue;
      const span = t1 - t0;
      const blend = span > 0 ? (time - t0) / span : 0;
      const l0 = this.scriptLevel[i] as number;
      return l0 + ((this.scriptLevel[i + 1] as number) - l0) * blend;
    }
    return this.scriptLevel[last] as number;
  }
}
