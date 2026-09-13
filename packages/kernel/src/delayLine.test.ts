import { describe, expect, it } from 'vitest';
import { DelayLine } from './delayLine.js';

describe('DelayLine', () => {
  it('returns the value from exactly k ticks ago', () => {
    const line = new DelayLine(2, 5);
    for (let t = 0; t < 20; t++) line.push([t, t * 10]);
    const out = new Float64Array(2);
    for (let k = 0; k <= 5; k++) {
      const r = line.read(k, out);
      expect(r.available).toBe(k);
      expect(Array.from(out)).toEqual([19 - k, (19 - k) * 10]);
    }
  });

  it('wraps the ring without corrupting older entries', () => {
    const line = new DelayLine(1, 3);
    const out = new Float64Array(1);
    for (let t = 1; t <= 1000; t++) {
      line.push([t]);
      if (t > 3) {
        line.read(3, out);
        expect(out[0]).toBe(t - 3);
      }
    }
  });

  it('delivers the oldest available value before it has filled, and says so', () => {
    // A reflex at t = 0 has nothing to react to. The earliest known value avoids a transient from
    // zeros, and `available` lets the caller know the delay is not yet the one it asked for.
    const line = new DelayLine(1, 10);
    const out = new Float64Array(1);
    expect(line.read(4, out).available).toBe(-1);
    line.push([7]);
    line.push([8]);
    const r = line.read(4, out);
    expect(r.requested).toBe(4);
    expect(r.available).toBe(1);
    expect(out[0]).toBe(7);
  });

  it('does not allocate on push or read', () => {
    const line = new DelayLine(3, 4);
    const src = new Float64Array([1, 2, 3]);
    const out = new Float64Array(3);
    const before = line.getState().ring.length;
    for (let i = 0; i < 100; i++) {
      line.push(src);
      line.read(2, out);
    }
    expect(line.getState().ring.length).toBe(before);
  });

  it('rejects out-of-range delays and mismatched widths', () => {
    const line = new DelayLine(2, 3);
    expect(() => line.read(4, new Float64Array(2))).toThrow(/outside 0..3/);
    expect(() => line.read(-1, new Float64Array(2))).toThrow(/outside 0..3/);
    expect(() => line.push([1])).toThrow(/expects 2 elements/);
    expect(() => line.read(0, new Float64Array(3))).toThrow(/needs 2 elements/);
    expect(() => new DelayLine(0, 1)).toThrow(/positive integer/);
  });

  it('supports a zero-tick line as a plain latch', () => {
    const line = new DelayLine(1, 0);
    const out = new Float64Array(1);
    line.push([5]);
    line.push([6]);
    line.read(0, out);
    expect(out[0]).toBe(6);
  });

  it('round-trips its state exactly', () => {
    // Spec 13.7: a restored session must continue as the captured one would have. A delay line's
    // history is state, and a restore that forgot it would replay a reflex against stale input.
    const a = new DelayLine(2, 6);
    for (let t = 0; t < 11; t++) a.push([t, -t]);
    const state = a.getState();
    const b = new DelayLine(2, 6);
    b.setState(state);
    const oa = new Float64Array(2);
    const ob = new Float64Array(2);
    for (let k = 0; k <= 6; k++) {
      a.read(k, oa);
      b.read(k, ob);
      expect(Array.from(ob)).toEqual(Array.from(oa));
    }
    a.push([99, 99]);
    b.push([99, 99]);
    a.read(3, oa);
    b.read(3, ob);
    expect(Array.from(ob)).toEqual(Array.from(oa));
  });

  it('resets to empty', () => {
    const line = new DelayLine(1, 2);
    line.push([1]);
    line.reset();
    expect(line.filled).toBe(0);
    const out = new Float64Array(1);
    expect(line.read(0, out).available).toBe(-1);
  });
});
