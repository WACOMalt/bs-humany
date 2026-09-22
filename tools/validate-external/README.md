# External reference models

Spec section 13.6 and ADR-009 tier 3. These are somebody else's models, kept here so the
validation tool can compare our articulation against them without a network and so the
comparison is reproducible from the repository alone.

## MyoSuite `myo_sim`

- Source: <https://github.com/MyoHub/myo_sim>
- Commit: `eb327acbae0fad12279495040607f5235d962328` ("0.2.2 release", 2026-08-27)
- Licence: Apache-2.0, in `myo_sim/LICENSE`
- Files: the chain and asset MJCF for the leg, arm, torso and head models, plus the muscle and
  tendon MJCF for the arm (`myoarm_r_*`), the legs (`myolegs_*`) and the torso -- both the
  abdomen model (`myotorso_abdomen_muscle.xml`, `myotorso_abdomen_tendon.xml`, three actuators a
  side) and the full lumbar one (`myotorso_muscle.xml`, `myotorso_tendon.xml`, 210 fascicles),
  the latter read only to see what it says about the two the abdomen model leaves unusable
- Meshes: `meshes/`, the 67 bone meshes those models reference, 7.5 MB, fetched and verified by
  `node tools/validate-external/fetch-meshes.mjs`. Only what the models ask for: the repository
  also carries prosthetic and exoskeleton parts and a scene with a logo in it, four times as much
  again and nothing to do with a skeleton. The script reads the asset files for the list rather
  than keeping one, so a model that starts using another bone is followed without anyone
  remembering. `--check` verifies without fetching.

The arm muscle and tendon files are here for a second reason beyond validation. The muscle file
is the source of the elbow Hill-type parameters in `packages/muscle-data`, which are extracted by
`pnpm generate:elbow-muscles` rather than transcribed, and checked in CI. That is a value source
in the sense of section 5.3 and it is allowed here because `caggiano2022` is T1: the models are
Apache-2.0, so unlike MyoSkeleton they may be used in core packages as well as in tooling. Only
the *scalar* parameters cross -- peak force and the two lengths. Nothing in the source's own body
frames does, because a coordinate is only meaningful in the frame it was measured in.

Every file is byte-identical to that commit. To check, or to move to a newer one:

```bash
gh api "repos/MyoHub/myo_sim/contents/myo_sim/models/leg/assets/myolegs_chain.xml?ref=<commit>" --jq .sha
git hash-object tools/validate-external/myo_sim/myolegs_chain.xml
```

Both print the same object id for a matching file, because GitHub's blob sha and git's are the
same hash. Update the commit above whenever the files change, and re-run the validation.

These are a *reference*, not a source of values in the sense of section 5.3: values transcribed
from them are cited to `caggiano2022` at the point of use.

Nothing here is compiled into a published package, with one stated exception: the studio's Align
tab loads `meshes/` and the extracted muscle paths at runtime so the two skeletons can be seen
side by side, which is what makes pairing our bones to theirs possible by eye. They are fetched
from `public/`, not bundled, so a studio nobody aligns anything in never carries them. Apache-2.0
permits the redistribution; the licence and the attribution above travel with the files, and the
pinned commit is what makes the copy checkable.

## MyoSkeleton

Not vendored and never will be: its licence is non-commercial, which cannot be combined with the
CC BY-SA skeleton data (ADR-009, ADR-011). The validation tool reads it from a path given in
`MYOSKELETON_XML` when a developer has their own copy, and reports only whether a structure
agrees, never a number from it.
