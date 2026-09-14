# @bs-humany/assets-anatomical

Per-bone meshes and named landmarks for the 206-bone skeleton, keyed by HSDL bone `id`, derived
from the Z-Anatomy skeletal export (itself derived from BodyParts3D). **Data is CC BY-SA 4.0** —
see `NOTICE` and `LICENSE`.

Regenerate with:

```bash
pnpm --filter @bs-humany/ingest run ingest <SkeletalSystem100.fbx>
```

`data/INGEST-REPORT.txt` records the source hash, counts and every left/right discrepancy found.

## Collision hulls

`data/hulls.json` holds a convex decomposition of every segment's bones for every segmentation
profile (CoACD, at most three pieces per bone and twelve per segment, at most 48 vertices per
piece), in the anchor bone's frame at the dataset stature. The skeleton package turns them into
`convexHull` proxies; nothing decomposes a mesh at runtime. Regenerate after the pack or a
segmentation profile changes:

```bash
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -r tools/ingest/requirements.txt
COACD_PYTHON=.venv/bin/python pnpm --filter @bs-humany/ingest run hulls
```

Takes about half an hour on eight cores. The result is deterministic for a given CoACD version.
