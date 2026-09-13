/**
 * Delay lines -- M2.4. Built and tested in Phase 1; used by nothing in Phase 1.
 *
 * Spec section 10.5 and 14.1: neural conduction delay is a first-order determinant of whether a
 * reflex loop behaves or oscillates, and retrofitting delay into a synchronous channel system is
 * architecturally invasive. So the primitive exists now.
 *
 * A `DelayLine` is a ring of snapshots of one channel field, sized in ticks. Each tick the current
 * value is pushed and the value from `k` ticks ago becomes readable. No allocation after
 * construction: the ring is preallocated and pushes copy into it.
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
   * Copy the value from `delayTicks` ago into `out`. `0` is the most recent push.
   *
   * Before the line has filled that far back, the oldest available value is returned instead
   * of garbage, and `available` reports what was actually delivered. A reflex arc at t = 0 has
   * nothing to react to; returning the earliest known value is the physically honest choice and
   * avoids a startup transient from zeros.
   */
  read(delayTicks: number, out: Float64Array): { requested: number; available: number } {
    if (!Number.isInteger(delayTicks) || delayTicks < 0 || delayTicks > this.maxDelayTicks) {
      throw new Error(`Delay ${delayTicks} is outside 0..${this.maxDelayTicks}.`);
    }
    if (out.length !== this.#width) {
      throw new Error(`Output needs ${this.#width} elements, got ${out.length}.`);
    }
    if (this.#filled === 0) {
      out.fill(0);
      return { requested: delayTicks, available: -1 };
    }
    const available = Math.min(delayTicks, this.#filled - 1);
    const slot = (this.#head - 1 - available + this.#capacity * 2) % this.#capacity;
    const base = slot * this.#width;
    for (let i = 0; i < this.#width; i++) out[i] = this.#ring[base + i] ?? 0;
    return { requested: delayTicks, available };
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
