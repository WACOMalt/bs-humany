/**
 * A PC2 vertex cache, which is how a deforming mesh gets out of here without destroying Blender.
 *
 * ## Why this exists
 *
 * The muscle bellies used to leave as skinned meshes: one armature bone per cross-section, keyed
 * every sample. It is a faithful description and it is ruinous. A hundred and forty-eight units
 * at twenty-four rings apiece is 3552 bones, each with a translation, a rotation and a scale
 * curve, and Blender holds a keyframe as a BezTriple -- a value, two handles, an interpolation
 * mode -- at some seventy bytes apiece. Measured rather than guessed: six tenths of a second of
 * simulation imported into Blender 5.0 took **4.3 gigabytes** and thirty-four seconds, and the
 * muscles were ninety-six per cent of the animation channels in the file. Fifteen seconds of it
 * would want a hundred gigabytes, which is the crash.
 *
 * The browser never had the problem because it never builds any of that: the studio holds a flat
 * array of ring frames and reads one frame at a time.
 *
 * So the bellies leave as what they are -- a mesh whose vertices move -- and Blender has a native
 * way to carry that which streams from disk instead of loading into memory: the Mesh Cache
 * modifier, which reads MDD or PC2. One sample per output frame, one modifier, no keyframes at
 * all, and the memory a scene needs stops depending on how long the run was.
 *
 * ## The format
 *
 * Small enough to state completely. A 32-byte header, little-endian throughout:
 *
 *   char  signature[12]   "POINTCACHE2\0"
 *   int32 fileVersion     1
 *   int32 numPoints
 *   f32   startFrame
 *   f32   sampleRate      frames between samples; 1 means one sample per frame
 *   int32 numSamples
 *
 * then `numSamples * numPoints` triples of float32, in the mesh's own vertex order. The vertex
 * order is the contract: the cache says where vertex N is and nothing else, so the mesh it is
 * applied to must be the one it was written for.
 */

/** Bytes before the first sample. */
export const PC2_HEADER_BYTES = 32;

export interface PointCacheHeader {
  readonly points: number;
  readonly samples: number;
  /** Frame the first sample belongs to. */
  readonly startFrame: number;
  /** Frames between samples. One sample per frame is 1. */
  readonly sampleRate: number;
}

/** How large a cache of this shape will be, for a caller deciding whether to write one. */
export function pointCacheBytes(header: PointCacheHeader): number {
  return PC2_HEADER_BYTES + header.points * header.samples * 12;
}

/**
 * Write a PC2 whose samples come from `sample`, called once per sample index.
 *
 * `sample` fills the array it is handed -- `points * 3` floats, x, y, z per vertex -- rather than
 * returning one, so a caller with a scratch buffer keeps it and a long cache does not allocate a
 * fresh array per frame.
 */
export function writePointCache(
  header: PointCacheHeader,
  sample: (index: number, into: Float32Array) => void,
): Uint8Array {
  const { points, samples, startFrame, sampleRate } = header;
  if (!Number.isInteger(points) || points <= 0) {
    throw new Error(`A point cache needs a positive whole number of points, got ${points}.`);
  }
  if (!Number.isInteger(samples) || samples < 0) {
    throw new Error(`A point cache needs a whole number of samples, got ${samples}.`);
  }
  const out = new Uint8Array(pointCacheBytes(header));
  const view = new DataView(out.buffer);
  // "POINTCACHE2" and the NUL that closes the twelve bytes.
  const signature = 'POINTCACHE2';
  for (let i = 0; i < signature.length; i++) out[i] = signature.charCodeAt(i);
  out[11] = 0;
  view.setInt32(12, 1, true);
  view.setInt32(16, points, true);
  view.setFloat32(20, startFrame, true);
  view.setFloat32(24, sampleRate, true);
  view.setInt32(28, samples, true);

  const scratch = new Float32Array(points * 3);
  for (let s = 0; s < samples; s++) {
    scratch.fill(0);
    sample(s, scratch);
    // Through a Float32Array view rather than setFloat32 per component: the same bytes, and the
    // difference over a hundred million of them is minutes.
    new Float32Array(out.buffer, PC2_HEADER_BYTES + s * points * 12, points * 3).set(scratch);
  }
  return out;
}
