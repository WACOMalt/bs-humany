/**
 * Simulation time.
 *
 * Spec section 10.6. Two rules, both of which exist because violating them breaks reproducibility
 * in ways that are very hard to notice:
 *
 * 1. **`simTime` is computed as `tick * dt`, never accumulated.** Repeatedly adding `dt` to a
 *    running float accumulates rounding error without bound. After an hour at 500 Hz that is well
 *    over a million additions, and two runs that took different numbers of steps to reach the same
 *    tick would report different times. Multiplication is exact in the integer tick.
 *
 * 2. **`dt` is immutable for a session.** Changing the timestep changes results, so it is not a
 *    setting -- it is part of the identity of a run. Changing it requires a new session.
 *
 * Wall-clock time does not appear in this file at all. `performance.now()` is banned in simulation
 * code (CONTRIBUTING rule 7); the render loop owns the mapping from real time to ticks, and does
 * so through `accumulateFrame` below, which is a pure function of the elapsed time handed to it.
 */

export interface SimClockSnapshot {
  readonly tick: number;
  readonly dt: number;
}

export class SimClock {
  /** Integer, monotonic. The authoritative measure of simulation progress. */
  #tick = 0;

  /** Fixed timestep in seconds. Immutable for the life of this clock. */
  readonly dt: number;

  /** Physics rate in Hz, as supplied. Kept for display -- `dt` is the authority. */
  readonly rate: number;

  constructor(rateHz: number) {
    if (!Number.isFinite(rateHz) || rateHz <= 0) {
      throw new Error(`Physics rate must be a positive finite number of Hz, got ${rateHz}.`);
    }
    this.rate = rateHz;
    this.dt = 1 / rateHz;
  }

  get tick(): number {
    return this.#tick;
  }

  /**
   * Seconds of simulated time elapsed.
   *
   * Derived, never accumulated. See rule 1 above.
   */
  get simTime(): number {
    return this.#tick * this.dt;
  }

  advance(): number {
    this.#tick += 1;
    return this.#tick;
  }

  reset(): void {
    this.#tick = 0;
  }

  /** True when a module with this rate divisor should run on the current tick. */
  shouldRun(rateDivisor: number): boolean {
    if (!Number.isInteger(rateDivisor) || rateDivisor < 1) {
      throw new Error(`rateDivisor must be a positive integer, got ${rateDivisor}.`);
    }
    return this.#tick % rateDivisor === 0;
  }

  snapshot(): SimClockSnapshot {
    return { tick: this.#tick, dt: this.dt };
  }

  restore(snapshot: SimClockSnapshot): void {
    if (snapshot.dt !== this.dt) {
      throw new Error(
        `Cannot restore a snapshot taken at dt=${snapshot.dt} into a clock running at ` +
          `dt=${this.dt}. Timestep is part of a run's identity: the same model stepped at a ` +
          'different rate produces different results, so the two are not interchangeable.',
      );
    }
    this.#tick = snapshot.tick;
  }
}

export interface FrameStepPlan {
  /** How many fixed ticks to run this frame. */
  readonly ticks: number;
  /**
   * Fraction of a timestep left over, in `[0, 1)`.
   *
   * The renderer interpolates between the last two simulation states by this amount. Drawing raw
   * simulation state at render rate instead produces visible judder whenever the two rates do not
   * divide evenly.
   */
  readonly alpha: number;
  /** Accumulator to carry into the next frame. */
  readonly remainder: number;
  /**
   * True when the frame's elapsed time exceeded `maxTicks * dt` and time was discarded.
   *
   * Surfaced rather than swallowed: it means the simulation is running slower than real time, and
   * a UI that hides that is telling the user their model is faster than it is.
   */
  readonly clamped: boolean;
}

/**
 * Ceiling on how many fixed ticks one frame may run.
 *
 * The clamp exists for genuine stalls -- a backgrounded tab, a breakpoint, a garbage-collection
 * pause -- and must **not** engage during normal operation, or the simulation runs in permanent
 * slow motion while reporting that it is clamped.
 *
 * Sizing it therefore has to account for the supported physics rates (240, 500 and 1000 Hz per
 * spec section 12) against real display rates. The steady-state requirement is
 * `physicsRate / displayRate` ticks per frame:
 *
 * | Physics | 60 fps | 30 fps |
 * |---------|--------|--------|
 * | 240 Hz  | 4      | 8      |
 * | 500 Hz  | 8.34   | 16.7   |
 * | 1000 Hz | 16.7   | 33.4   |
 *
 * So a naive default of 8 would clamp continuously at 500 Hz and 60 fps, which is a perfectly
 * ordinary configuration. 60 leaves headroom down to roughly 17 fps at the highest rate while
 * still bounding a stall: a tab backgrounded for five seconds at 500 Hz would otherwise queue
 * 2500 steps.
 */
export const DEFAULT_MAX_TICKS_PER_FRAME = 60;

/**
 * Decide how many fixed ticks a frame of real elapsed time should run.
 *
 * Pure, so it is testable without a clock. The `maxTicks` clamp prevents the death spiral where a
 * slow frame schedules more steps, which makes the next frame slower still. See
 * `DEFAULT_MAX_TICKS_PER_FRAME` for why the default is what it is.
 */
export function accumulateFrame(
  accumulator: number,
  elapsedSeconds: number,
  dt: number,
  maxTicks = DEFAULT_MAX_TICKS_PER_FRAME,
): FrameStepPlan {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new Error(`Elapsed time must be a non-negative finite number, got ${elapsedSeconds}.`);
  }

  let pending = accumulator + elapsedSeconds;
  let ticks = Math.floor(pending / dt);
  let clamped = false;

  if (ticks > maxTicks) {
    ticks = maxTicks;
    // Discard the excess rather than carrying it, which is what stops the spiral.
    pending = ticks * dt + (pending % dt);
    clamped = true;
  }

  const remainder = pending - ticks * dt;
  return { ticks, alpha: remainder / dt, remainder, clamped };
}
