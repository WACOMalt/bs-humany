# External reference models

Spec section 13.6 and ADR-009 tier 3. These are somebody else's models, kept here so the
validation tool can compare our articulation against them without a network and so the
comparison is reproducible from the repository alone.

## MyoSuite `myo_sim`

- Source: <https://github.com/MyoHub/myo_sim>
- Commit: `eb327acbae0fad12279495040607f5235d962328` ("0.2.2 release", 2026-08-27)
- Licence: Apache-2.0, in `myo_sim/LICENSE`
- Files: the chain and asset MJCF for the leg, arm, torso and head models, plus the arm's
  muscle and tendon MJCF (`myoarm_r_muscle.xml`, `myoarm_r_tendon.xml`)

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
from them are cited to `caggiano2022` at the point of use. Nothing here is compiled into a
published package.

## MyoSkeleton

Not vendored and never will be: its licence is non-commercial, which cannot be combined with the
CC BY-SA skeleton data (ADR-009, ADR-011). The validation tool reads it from a path given in
`MYOSKELETON_XML` when a developer has their own copy, and reports only whether a structure
agrees, never a number from it.
