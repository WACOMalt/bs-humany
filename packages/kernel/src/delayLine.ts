/**
 * Delay lines. Built in M2.4 per spec 10.5; `SpinalModule` (ADR-014) delays every afferent
 * through one. No allocation after construction.
 *
 * Spec sections 10.5 and 14.1: neural conduction delay is a first-order determinant of whether a
 * reflex loop behaves or oscillates, and retrofitting delay into a synchronous channel system is
 * architecturally invasive. So the primitive was built in Phase 1, before anything used it, and
 * the cord was its first consumer.
 *
 * A `DelayLine` is a ring of snapshots of one channel field, sized in ticks. Each tick the current
 * value is pushed and the value from `k` ticks ago becomes readable. The ring is preallocated,
 * pushes copy into it and reads copy out of it, and a read answers with a plain number rather
 * than an object, so a module that pushes and reads every tick allocates nothing in its step
 * (CONTRIBUTING rule 9).
 */

export class DelayLine {
  readonly #ring: Float64Array;
  readonly #width: number;
  readonly #capacity: number;
  #head = 0;
  #filled = 0;

  /**
   * @param width elements per snapshot (the channel field's length)
   * @param maxDelayTicks the longest delay that will be asked for
   */
  constructor(width: number, maxDelayTicks: number) {
    if (!Number.isInteger(width) || width < 1) {
      throw new Error(`DelayLine width must be a positive integer, got ${width}.`);
    }
    if (!Number.isInteger(maxDelayTicks) || maxDelayTicks < 0) {
      throw new Error(
        `DelayLine maxDelayTicks must be a non-negative integer, got ${maxDelayTicks}.`,
      );
    }
    this.#width = width;
    this.#capacity = maxDelayTicks + 1;
    this.#ring = new Float64Array(this.#capacity * width);
  }

  get width(): number {
    return this.#width;
  }

  get maxDelayTicks(): number {
    return this.#capacity - 1;
  }

  /** Ticks recorded so far, saturating at the capacity. */
  get filled(): number {
    return this.#filled;
  }

  /** Record the current value. Copies; the source may be reused immediately. */
  push(value: ArrayLike<number>): void {
    if (value.length !== this.#width) {
      throw new Error(`DelayLine expects ${this.#width} elements per push, got ${value.length}.`);
    }
    const base = this.#head * this.#width;
    for (let i = 0; i < this.#width; i++) this.#ring[base + i] = value[i] ?? 0;
    this.#head = (this.#head + 1) % this.#capacity;
    if (this.#filled < this.#capacity) this.#filled++;
  }

  /**
   * Copy the value from `delayTicks` ago into `out`, and return how many ticks ago the value
   * actually delivered is. `0` is the most recent push.
   *
   * Before the line has filled that far back, the oldest available value is delivered instead
   * of garbage, and the return says how old it really is: less than `delayTicks` while the line
   * fills, and -1 before anything has been pushed, when `out` is zeros. A reflex arc at t = 0 has
   * nothing to react to; returning the earliest known value is the physically honest choice and
   * avoids a startup transient from zeros.
   *
   * The answer is a number rather than a `{ requested, available }` pair because this is called
   * every tick from inside a module's step, and an object per call is an allocation per tick. The
   * caller already knows what it requested.
   */
  read(delayTicks: number, out: Float64Array): number {
    if (!Number.isInteger(delayTicks) || delayTicks < 0 || delayTicks > this.maxDelayTicks) {
      throw new Error(`Delay ${delayTicks} is outside 0..${this.maxDelayTicks}.`);
    }
    if (out.length !== this.#width) {
      throw new Error(`Output needs ${this.#width} elements, got ${out.length}.`);
    }
    if (this.#filled === 0) {
      out.fill(0);
      return -1;
    }
    const available = Math.min(delayTicks, this.#filled - 1);
    const slot = (this.#head - 1 - available + this.#capacity * 2) % this.#capacity;
    const base = slot * this.#width;
    for (let i = 0; i < this.#width; i++) out[i] = this.#ring[base + i] ?? 0;
    return available;
  }

  reset(): void {
    this.#ring.fill(0);
    this.#head = 0;
    this.#filled = 0;
  }

  /** Snapshot for serialisation. */
  getState(): { ring: Float64Array; head: number; filled: number } {
    return { ring: this.#ring.slice(), head: this.#head, filled: this.#filled };
  }

  setState(state: { ring: ArrayLike<number>; head: number; filled: number }): void {
    if (state.ring.length !== this.#ring.length) {
      throw new Error(
        `DelayLine state has ${state.ring.length} elements, expected ${this.#ring.length}.`,
      );
    }
    this.#ring.set(state.ring);
    this.#head = state.head;
    this.#filled = state.filled;
  }
}
