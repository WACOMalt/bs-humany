# @bs-humany/assets-anatomical

Per-bone meshes and named landmarks for the 206-bone skeleton, keyed by HSDL bone `id`, derived
from the Z-Anatomy skeletal export (itself derived from BodyParts3D). **Data is CC BY-SA 4.0** —
see `NOTICE` and `LICENSE`.

Regenerate with:

```bash
pnpm --filter @bs-humany/ingest run ingest <SkeletalSystem100.fbx>
```

`data/INGEST-REPORT.txt` records the source hash, counts and every left/right discrepancy found.
