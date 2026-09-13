/**
 * `@bs-humany/assets-anatomical` -- loader for the packed skeleton mesh data.
 *
 * The data (`data/skeleton.bin`, `data/manifest.json`, `data/landmarks.json`) is CC BY-SA 4.0,
 * derived from Z-Anatomy and BodyParts3D; see NOTICE. This code is Apache-2.0 and is pure: it
 * takes bytes and a manifest and returns typed arrays, so it runs identically in Node and in the
 * browser, and in a test without a network.
 *
 * Meshes are stored in the canonical world frame (`+X` right, `+Y` up, `+Z` posterior), in metres,
 * in the dataset subject's anatomical position with the soles at `y = 0`. Nothing here scales
 * them: the caller places and scales bones (see `buildSkeletonMesh`).
 */

export interface PackedBone {
  readonly id: string;
  readonly source: readonly string[];
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly centroid: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface SkeletonManifest {
  readonly format: 'bs-humany.skeleton-mesh/1';
  readonly dataset: {
    readonly name: string;
    readonly version: string;
    readonly license: string;
    readonly attribution: readonly string[];
    readonly sourceFile: string;
    readonly sourceSha256: string;
  };
  readonly subjectStature: number;
  readonly units: 'm';
  readonly bones: readonly PackedBone[];
  readonly totals: {
    readonly vertices: number;
    readonly triangles: number;
    readonly bytes: number;
  };
}

/** One bone's geometry, as views into the shared buffer. No copy is made. */
export interface BoneMesh {
  readonly id: string;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly centroid: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface SkeletonAssets {
  readonly manifest: SkeletonManifest;
  readonly bones: ReadonlyMap<string, BoneMesh>;
  /** Landmark positions per bone, world metres at the dataset stature, keyed by feature name. */
  readonly landmarks: Readonly<
    Record<string, Readonly<Record<string, readonly [number, number, number]>>>
  >;
}

/** Text the licence requires wherever the data is shown. One place, so it cannot drift. */
export function attributionText(manifest: SkeletonManifest): string {
  return `${manifest.dataset.attribution.join(' · ')} (${manifest.dataset.license})`;
}

/**
 * Slice the packed buffer into per-bone views.
 *
 * Validates the layout against the manifest before handing anything back: an offset past the end
 * of the buffer means the two files are from different ingestion runs, which is a mismatch worth
 * failing on rather than rendering garbage from.
 */
export function parseSkeletonAssets(
  manifest: SkeletonManifest,
  bin: ArrayBuffer,
  landmarks: SkeletonAssets['landmarks'] = {},
): SkeletonAssets {
  if (manifest.format !== 'bs-humany.skeleton-mesh/1') {
    throw new Error(`Unsupported skeleton mesh format '${String(manifest.format)}'.`);
  }
  const positionBytes = manifest.totals.vertices * 3 * 4;
  const indexBytes = manifest.totals.triangles * 3 * 4;
  if (bin.byteLength !== positionBytes + indexBytes) {
    throw new Error(
      `skeleton.bin is ${bin.byteLength} bytes but the manifest describes ${positionBytes + indexBytes}. ` +
        'The two files are from different ingestion runs.',
    );
  }
  const positions = new Float32Array(bin, 0, manifest.totals.vertices * 3);
  const indices = new Uint32Array(bin, positionBytes, manifest.totals.triangles * 3);

  const bones = new Map<string, BoneMesh>();
  for (const b of manifest.bones) {
    if (
      b.vertexOffset + b.vertexCount > manifest.totals.vertices ||
      b.indexOffset + b.indexCount > indices.length
    ) {
      throw new Error(`Bone '${b.id}' extends past the packed buffer.`);
    }
    bones.set(b.id, {
      id: b.id,
      positions: positions.subarray(b.vertexOffset * 3, (b.vertexOffset + b.vertexCount) * 3),
      indices: indices.subarray(b.indexOffset, b.indexOffset + b.indexCount),
      centroid: b.centroid,
      min: b.min,
      max: b.max,
    });
  }
  return { manifest, bones, landmarks };
}

/** Node-side convenience: read the three data files from disk. Not for the browser. */
export async function loadSkeletonAssetsFromDisk(dataDir: string): Promise<SkeletonAssets> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const [manifestText, bin, landmarksText] = await Promise.all([
    readFile(join(dataDir, 'manifest.json'), 'utf8'),
    readFile(join(dataDir, 'skeleton.bin')),
    readFile(join(dataDir, 'landmarks.json'), 'utf8'),
  ]);
  const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  return parseSkeletonAssets(JSON.parse(manifestText), buffer, JSON.parse(landmarksText));
}
