/**
 * Trajectory hashing for golden tests -- spec section 13.2.
 *
 * FNV-1a over the exact bit patterns of every sampled position, orientation and joint
 * coordinate. Any change in behaviour, however small, changes the hash; that is the point.
 *
 * MuJoCo, the only backend, runs as WebAssembly, whose arithmetic is IEEE 754 with nothing left
 * to the platform, so the solver itself is portable. The TypeScript around it is portable too as
 * far as its arithmetic goes, but it calls `Math.exp`, `Math.cos` and the like, whose last bit
 * ECMAScript leaves to the engine; one Node version computes them the same way everywhere, a
 * different one need not. So the goldens file records the platform each hash was produced on: if
 * two machines ever disagree, the divergence can be explained rather than argued about, and a
 * mismatch names the recorded platform when it is not the one running (`goldenSuite.ts`).
 */

import type { Trajectory } from './runner.js';

export function trajectoryHash(trajectory: Trajectory): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x5bd1e995;
  const mix = (byte: number) => {
    h1 ^= byte;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= byte;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  };
  const view = new DataView(new ArrayBuffer(8));
  const feed = (values: Float64Array) => {
    for (let i = 0; i < values.length; i++) {
      view.setFloat64(0, values[i] as number, true);
      for (let b = 0; b < 8; b++) mix(view.getUint8(b));
    }
  };
  for (const s of trajectory.samples) {
    feed(s.position);
    feed(s.orientation);
    feed(s.q);
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
