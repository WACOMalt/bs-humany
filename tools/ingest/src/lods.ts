/**
 * Decimated levels of detail of the mesh pack -- milestone M5.8.
 *
 *   COACD_PYTHON=.venv/bin/python pnpm --filter @bs-humany/ingest lods [dataDir]
 *
 * Writes `skeleton-lod1.bin` and `manifest-lod1.json` next to the full pack: the same format,
 * a quarter of the triangles, identical centroids and bounds (scripts/decimate.py). A phone
 * loads the small pack first and the full one only if it asks for it.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(HERE, '../../../packages/assets-anatomical/data'));
const python = process.env.COACD_PYTHON ?? 'python3';

/** LOD name and fraction of triangles kept. */
export const LODS: readonly (readonly [string, number])[] = [['lod1', 0.25]];

for (const [name, keep] of LODS) {
  const run = spawnSync(
    python,
    [join(HERE, '../scripts/decimate.py'), dataDir, name, String(keep)],
    {
      stdio: 'inherit',
    },
  );
  if (run.status !== 0) throw new Error(`decimate.py failed with status ${run.status}`);
}
