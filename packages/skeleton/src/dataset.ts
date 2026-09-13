/**
 * The measured skeleton's manifest, bundled as JSON.
 *
 * A few hundred kilobytes and no geometry, so the document can place bones and landmarks where
 * the dataset measured them without loading the mesh pack. Lives in its own module because both
 * the document builder and the landmark table need it, and one imports the other.
 */

import type { SkeletonManifest } from '@bs-humany/assets-anatomical';
import manifestJson from '@bs-humany/assets-anatomical/data/manifest.json' with { type: 'json' };

export const DATASET_MANIFEST: SkeletonManifest = manifestJson as unknown as SkeletonManifest;
