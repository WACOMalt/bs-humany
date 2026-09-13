/**
 * Trajectory hashing for golden tests -- spec section 13.2.
 *
 * FNV-1a over the exact bit patterns of every sampled position, orientation and joint
 * coordinate. Any change in behaviour, however small, changes the hash; that is the point. The
 * hash is platform-specific to the extent the backend is (Rapier's WASM is deterministic on one
 * platform, MuJoCo's across them), which the goldens file records.
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
