import { describe, expect, it } from 'vitest';
import { tiltAt, tiltPulses, tiltedGravity, tiltingFloor } from './tiltingFloor.js';

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

  it('turns gravity by the tilt and keeps its size', () => {
    const level = { x: 0, y: -9.81, z: 0 };
    expect(tiltedGravity(level, { pitch: 0, roll: 0 })).toEqual({ x: 0, y: -9.81, z: -0 });
    const rolled = tiltedGravity(level, { pitch: 0, roll: 0.1 });
    expect(rolled.x).toBeGreaterThan(0);
    expect(Math.hypot(rolled.x, rolled.y, rolled.z)).toBeCloseTo(9.81, 9);
    const pitched = tiltedGravity(level, { pitch: 0.1, roll: 0 });
    expect(pitched.z).toBeLessThan(0);
    expect(Math.hypot(pitched.x, pitched.y, pitched.z)).toBeCloseTo(9.81, 9);
  });

  it('as a script, sets the tilt absolutely every tick', () => {
    const script = tiltingFloor(settings, 6);
    const seen: [number, number][] = [];
    const api = {
      segment: () => -1,
      segmentPosition: () => ({ x: 0, y: 0, z: 0 }),
      grab: () => {},
      moveGrab: () => {},
      release: () => {},
      drive: () => {},
      tiltWorld: (pitch: number, roll: number) => {
        seen.push([pitch, roll]);
      },
    };
    for (let i = 0; i < 600; i++) script(i * 0.01, api);
    expect(seen.length).toBe(600);
    expect(seen.some(([p, r]) => p !== 0 || r !== 0)).toBe(true);
    expect(seen[0]).toEqual([0, 0]);
  });
});
