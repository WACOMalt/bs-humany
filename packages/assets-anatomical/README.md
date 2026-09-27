# @bs-humany/assets-anatomical

Per-bone meshes and named landmarks for the 206-bone skeleton, keyed by HSDL bone `id`, derived
from the Z-Anatomy skeletal export (itself derived from BodyParts3D). **Data is CC BY-SA 4.0** —
see `NOTICE` and `LICENSE`.

`data/INGEST-REPORT.txt` records the source hash, counts, every left/right discrepancy found and,
from the next ingest on, every node name the export repeats.

## Regenerating the data

Everything in `data/` is written by a stage of `tools/ingest`, from the export or from what an
earlier stage wrote. The stages run in this order, because each reads what the ones before it
wrote; run out of order, a stage measures against a table that is about to change under it. There
is one command per phase:

| Phase | Command | When |
| --- | --- | --- |
| 1. Ingest | `pnpm --filter @bs-humany/ingest ingest <SkeletalSystem100.fbx>` | the dataset changes |
| 2. Re-measure | `pnpm --filter @bs-humany/ingest derive` | a rule or the pack changes |
| 3. Proxies | `hulls` and `lods` (below) | the pack or a segmentation profile changes |
| 4. Everything built from it | `pnpm regenerate` (repository root) | after any of the above |

`pnpm --filter @bs-humany/ingest ingest:all <SkeletalSystem100.fbx>` runs phases 1 and 2
together, and `ingest` prints the next command when it finishes.

### The stages

1. **`ingest <fbx>`** reads the export -- the 500 MB `SkeletalSystem100.fbx`, which is not in the
   repository -- and writes `manifest.json`, `skeleton.bin` (the pack), `landmarks.json` (the
   export's markers, plus the points `derived.ts` measures), `landmarks-derived.json` (the rule
   behind each measured point) and `INGEST-REPORT.txt`. It refuses an export in which a name a
   bone is looked up by belongs to more than one mesh.

   The remaining stages read the pack instead of the export, so they re-run in seconds without it.
   Each takes the data directory as an optional argument, so a scratch copy can be re-measured
   without touching this one.

2. **`derived-from-pack`** re-runs every rule of `derived.ts` on the pack. Reads `manifest.json`,
   `skeleton.bin`, `landmarks.json` and `landmarks-derived.json`; rewrites `landmarks.json` and
   `landmarks-derived.json` and writes `rib-arcs.json`.
3. **`surface-landmarks`** puts each marker back on the bone it names. Reads `manifest.json`,
   `skeleton.bin`, `landmarks.json` and `landmarks-derived.json`; writes `landmarks-surface.json`.
   Markers only: a point `landmarks-derived.json` records a rule for is on the bone already, and
   is skipped (OQ-032).
4. **`ridge-attachments`** measures where along a ridge a muscle starts. Reads `manifest.json`,
   `skeleton.bin`, `landmarks.json` and `landmarks-surface.json`; writes `ridge-attachments.json`.
5. **`centres`** fits the articular and contact joint centres. Reads `manifest.json`,
   `skeleton.bin` and `landmarks.json`; writes `articular-centres.json`.
6. **`wrap-radii`** measures the surfaces tendons turn over. Reads `manifest.json`,
   `skeleton.bin`, `landmarks.json`, `landmarks-surface.json` and `ridge-attachments.json`;
   writes `wrap-radii.json`.
7. **`hulls`** and **`lods`** (Python, `COACD_PYTHON` set; see below) read `manifest.json` and
   `skeleton.bin` -- `hulls` the skeleton's segmentation profiles too -- and write `hulls.json`
   and `skeleton-lod1.bin` + `manifest-lod1.json`.

`derive` runs stages 2 to 6 in that order. Where a stage looks a landmark up, it answers
the way the skeleton's landmark lookup does: a ridge point over a surface point over the raw
marker (`loadLocatedLandmarks` in `tools/ingest/src/packData.ts`, `LOCATED` in
`packages/skeleton/src/landmarks.ts`).

### Checked, and recorded by what they read

A measured table records `inputsSha256`, a hash of the files it was measured from, rather than
the day it was written: the same inputs give the same file byte for byte, so re-running `derive`
on unchanged data changes nothing, and a table whose inputs have since moved says so.

`pnpm --filter @bs-humany/ingest check` runs stages 2 to 6 with `--check`: each measures
in memory, compares with the committed file and writes nothing. `pnpm check:generated` runs it
first, so CI fails when a committed table is not what its stage measures. `pnpm regenerate` does
not re-measure the anatomy -- that is phase 2, taken on purpose -- but its closing check pass
holds these files like every other.

## Collision hulls

`data/hulls.json` holds a convex decomposition of every segment's bones for every segmentation
profile (CoACD, at most three pieces per bone and twelve per segment, at most 48 vertices per
piece), in the anchor bone's frame at the dataset stature. The skeleton package turns them into
`convexHull` proxies; nothing decomposes a mesh at runtime. Regenerate after the pack or a
segmentation profile changes:

```bash
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -r tools/ingest/requirements.txt
COACD_PYTHON=.venv/bin/python pnpm --filter @bs-humany/ingest run hulls
COACD_PYTHON=.venv/bin/python pnpm --filter @bs-humany/ingest run lods
```

`hulls` takes about half an hour on eight cores. Deterministic for the pinned versions, given the
recorded per-group tiers. `tools/ingest/requirements.txt` pins the Python packages exactly, and
each group replays the settings tier `hulls.json` records for it (`settings`), with no time limit,
so how busy the machine is cannot change which tier a group gets. Only a group the table does not
know yet climbs the timed ladder, and its tier is recorded for next time. The table records the
package versions that made it (`coacd`, `versions`). An interrupted run resumes from
`tools/ingest/.cache/hulls/`, which is keyed on the pack, so it never resumes another pack's work.
