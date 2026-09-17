/**
 * The PC2 writer, against the format Blender reads.
 *
 * Blender is the only consumer that matters and it is not in this test, so what is checked here
 * is the byte layout: a reader that agrees with the specification finds what was written. The
 * other half -- that Blender's Mesh Cache modifier reproduces these samples exactly -- is checked
 * by importing a real export into a real Blender, which cannot live in a unit test.
 */

import { describe, expect, it } from 'vitest';
import { PC2_HEADER_BYTES, pointCacheBytes, writePointCache } from './pointCache.js';

describe('a PC2 vertex cache', () => {
  it('writes a header a reader of the format finds what it expects in', () => {
    const cache = writePointCache(
      { points: 3, samples: 4, startFrame: 0, sampleRate: 1 },
      (index, into) => {
        for (let v = 0; v < 3; v++) {
          into[v * 3] = index;
          into[v * 3 + 1] = v;
          into[v * 3 + 2] = index * 10 + v;
        }
      },
    );
    expect(cache.length).toBe(PC2_HEADER_BYTES + 3 * 4 * 12);
    expect(cache.length).toBe(
      pointCacheBytes({ points: 3, samples: 4, startFrame: 0, sampleRate: 1 }),
    );

    const text = new TextDecoder().decode(cache.subarray(0, 11));
    expect(text).toBe('POINTCACHE2');
    expect(cache[11]).toBe(0);
    const view = new DataView(cache.buffer, cache.byteOffset, cache.byteLength);
    expect(view.getInt32(12, true)).toBe(1);
    expect(view.getInt32(16, true)).toBe(3);
    expect(view.getFloat32(20, true)).toBe(0);
    expect(view.getFloat32(24, true)).toBe(1);
    expect(view.getInt32(28, true)).toBe(4);

    // Every sample, in order, exactly as the callback filled it.
    for (let s = 0; s < 4; s++) {
      for (let v = 0; v < 3; v++) {
        const at = PC2_HEADER_BYTES + (s * 3 + v) * 12;
        expect(view.getFloat32(at, true), `sample ${s} vertex ${v}`).toBe(s);
        expect(view.getFloat32(at + 4, true)).toBe(v);
        expect(view.getFloat32(at + 8, true)).toBe(s * 10 + v);
      }
    }
  });

  it('refuses a shape it cannot write', () => {
    expect(() =>
      writePointCache({ points: 0, samples: 1, startFrame: 0, sampleRate: 1 }, () => {}),
    ).toThrow(/positive whole number/);
    expect(() =>
      writePointCache({ points: 2, samples: -1, startFrame: 0, sampleRate: 1 }, () => {}),
    ).toThrow(/whole number of samples/);
  });

  it('is the size a cache of that shape has to be', () => {
    // The number that decides whether this is worth doing at all: a hundred and forty-eight
    // bellies at twenty-four rings of twelve is 42,624 points, half a megabyte a frame, streamed.
    expect(pointCacheBytes({ points: 42624, samples: 1, startFrame: 0, sampleRate: 1 })).toBe(
      PC2_HEADER_BYTES + 42624 * 12,
    );
  });
});
