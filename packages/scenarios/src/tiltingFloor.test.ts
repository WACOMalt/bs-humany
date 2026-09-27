import { describe, expect, it } from 'vitest';
import { groundRotation, tiltAt, tiltPulses, tiltingFloor } from './tiltingFloor.js';

/** FNV-1a over the float64 bit patterns: equal only if every value is equal to the last bit. */
function bitHash(values: readonly number[]): string {
  const words = new Uint32Array(new Float64Array(values).buffer);
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) {
    h ^= words[i] as number;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('the tilting floor', () => {
  const settings = { tilt: 5, every: 0.8, hold: 0.3, seed: 7 };

  it('draws the same pulses from the same seed, and different ones from another', () => {
    const a = tiltPulses(settings, 6);
    const b = tiltPulses(settings, 6);
    const c = tiltPulses({ ...settings, seed: 8 }, 6);
    expect(a).toEqual(b);
    expect(a.map((p) => p.at)).not.toEqual(c.map((p) => p.at));
    // About one a period, spaced at least a fifth of a second, none past the end.
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(a.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < a.length; i++) expect(a[i]!.at - a[i - 1]!.at).toBeGreaterThanOrEqual(0.2);
    expect(a[a.length - 1]!.at).toBeLessThan(6);
  });

  it('draws the pulses it drew before it shared the nerves stream', () => {
    // Hashes of a minute of fifth-of-a-second pulses -- about 280 of them, over a thousand draws --
    // taken from the private xorshift32 this scenario had before it drew from
    // @bs-humany/modules-nerves. A fractional seed still rounds to the nearest whole one, and a
    // zero seed is still the stream of seed 1.
    const captured: Record<number, [number, string]> = {
      0: [280, '2d9d99f8'],
      1: [280, '2d9d99f8'],
      7: [279, '9f2eda81'],
      [0x9e3779b9]: [280, 'aa95bebd'],
    };
    for (const [key, [count, hash]] of Object.entries(captured)) {
      for (const seed of [Number(key), Number(key) + 0.3]) {
        const pulses = tiltPulses({ tilt: 5, every: 0.2, hold: 0.1, seed }, 60);
        expect(pulses).toHaveLength(count);
        expect(bitHash(pulses.flatMap((p) => [p.at, p.pitch, p.roll, p.hold]))).toBe(hash);
      }
    }
  });

  it('never tilts past the most asked for, and is level between pulses', () => {
    const pulses = tiltPulses(settings, 6);
    const max = (settings.tilt * Math.PI) / 180;
    let peak = 0;
    let level = 0;
    for (let t = 0; t < 6; t += 0.005) {
      const { pitch, roll } = tiltAt(pulses, t);
      const size = Math.hypot(pitch, roll);
      peak = Math.max(peak, size);
      if (size === 0) level += 1;
    }
    expect(peak).toBeLessThanOrEqual(max + 1e-9);
    expect(peak).toBeGreaterThan(max * 0.4);
    expect(level).toBeGreaterThan(0);
    // At the start nothing has happened yet.
    expect(tiltAt(pulses, 0)).toEqual({ pitch: 0, roll: 0 });
  });

  it('turns the floor about its own origin, as a unit rotation', () => {
    // Level is the identity, and every tilt is a rotation: the plane's normal turns with it and
    // nothing about the plane is scaled or moved.
    expect(groundRotation({ pitch: 0, roll: 0 })).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    for (const tilt of [
      { pitch: 0.1, roll: 0 },
      { pitch: 0, roll: 0.1 },
      { pitch: -0.08, roll: 0.05 },
    ]) {
      const q = groundRotation(tilt);
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
      // The plane's normal is its own +Y here, and it leans by the angle asked for.
      const up = {
        x: 2 * (q.x * q.y + q.z * q.w),
        y: 1 - 2 * (q.x * q.x + q.z * q.z),
        z: 2 * (q.y * q.z - q.x * q.w),
      };
      const lean = Math.acos(Math.min(1, up.y));
      expect(lean).toBeCloseTo(Math.hypot(tilt.pitch, tilt.roll), 2);
      // A pitch drops the front, a roll drops one side: each shows on its own axis.
      if (tilt.pitch !== 0) expect(Math.sign(up.z)).toBe(-Math.sign(tilt.pitch));
      if (tilt.roll !== 0) expect(Math.sign(up.x)).toBe(Math.sign(tilt.roll));
    }
  });

  it('as a script, sets the tilt absolutely every tick', () => {
    const script = tiltingFloor(settings, 6);
    const seen: [number, number, number][] = [];
    const api = {
      segment: () => -1,
      segmentPosition: () => ({ x: 0, y: 0, z: 0 }),
      grab: () => {},
      moveGrab: () => {},
      release: () => {},
      drive: () => {},
      moveStaticBox: (_id: string, position: { y: number }, rotation: { x: number; z: number }) => {
        seen.push([position.y, rotation.x, rotation.z]);
      },
    };
    for (let i = 0; i < 600; i++) script(i * 0.01, api);
    expect(seen.length).toBe(600);
    // Level to begin with: the platform square, its top face where the scenario put it.
    expect(seen[0]?.[1]).toBe(0);
    expect(seen[0]?.[2]).toBe(0);
    // And it turns: at some point the platform is not square any more.
    expect(seen.some(([, x, z]) => x !== 0 || z !== 0)).toBe(true);
  });
});
