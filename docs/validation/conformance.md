# Backend conformance and plausibility

Spec sections 13.2 to 13.4. Every scenario in `@bs-humany/scenarios` runs on MuJoCo, the only
backend, in `packages/testkit/src/goldenSuite.ts`, split by `GOLDEN_GROUPS` over the files in
`packages/testkit/src/goldens/` so that vitest steps them side by side. Two things are checked,
with the tolerances and their reasons written next to the numbers in `plausibility.ts` rather
than here, so they cannot drift apart. A third, conformance between backends, was retired with
Rapier.

## What is compared

**Plausibility**, on every scenario, those without a golden included: no NaN or Inf; the energy
balance (kinetic, gravitational, the elastic energy of the passive curves, less the work of
emulated couplings) never rises in a passive system beyond 2 J per 20 ms sample; no DoF past its
stop by more than 0.2 rad; penetration under 3 cm; joint drift under 1 mm; kinetic energy never
above 700 J anywhere in the run, the reference body's standing potential energy rounded up; the
body at rest (under 1 J kinetic) at the end, for scenarios that settle; the centre of mass
falling at g during free flight. A scenario whose drive or shake never stops says so with
`settles: false` and the reason beside it, rather than by raising the rest threshold: today that
is skull-wiggle, arm-flail, clip-walk-normal and clip-flail-arms. The peak bound still holds them.
A per-scenario override applies over the MuJoCo defaults, with its own reason where it is set;
the two left are drop-standing-collapse's energy rise and stairs-tumble's, which is the same
landing from lower.

**Goldens**: an FNV-1a hash of every sampled position, orientation and joint coordinate, per
scenario, profile and backend, committed in `packages/testkit/goldens/trajectories.json`, for the
fourteen scenarios whose `golden` is not false (tilting-floor and nerves-stand run a trained
policy, whose file changes with every training run). A changed hash fails the suite with the key,
the command to run and, if it differs from this machine, the platform the golden was recorded
on. A golden that no pinned scenario writes fails `goldens/coverage.test.ts`, which also holds
every scenario to exactly one group. Updating a golden is a deliberate commit with a written
reason (CONTRIBUTING rule 2): run `pnpm goldens:update`, which prints each changed key with its
old and new hash, the added keys and the pruned orphans, leaves entries it did not run alone (so
`pnpm goldens:update -t "scenario drop-"` updates only the drops), and keeps the recorded platform
of any key whose hash it reproduced. MuJoCo's hashes should not depend on the platform, but the
file records the platform they were produced on.

Each scenario has ten minutes of wall-clock time (`SCENARIO_TIMEOUT_MS`). The runner checks that
budget at each sample and stops a run that has used it with an error naming the scenario and the
tick it reached, because a test runner's own timeout cannot interrupt the synchronous stepping
loop; the slowest scenario takes about thirty seconds.

**Conformance, retired 2026-09-26.** Spec 13.3's harness ran two backends on the same scenario
and held them to each other: the centre of mass within 5 mm during the contact-free prefix, both
at rest at the end with resting centre-of-mass heights within 12 cm, and dissipated energy within
a quarter of the initial mechanical energy. It compared MuJoCo with Rapier, and had been skipped
since the ADR-003 reassessment of 2026-09-13 left only MuJoCo enabled. When the owner deleted
Rapier on 2026-09-26 there was nothing left for it to compare, so `conformance.ts`, its skipped
test and the scenarios' conformance tolerances were removed rather than kept waiting. A second
backend (a native or remote MuJoCo, or MJX) would bring it back, from the history of that file,
with tolerances measured for that pair rather than inherited from this one.

## Results, 2026-09-27, every scenario

Largest values seen per scenario on MuJoCo over the whole run, from a throwaway script calling
`runScenario` on each of the sixteen scenarios: range violation (rad), penetration (mm), joint
drift (mm), the largest rise of the energy balance between samples (J, checked only in a passive
system), kinetic energy at the end (J, checked only where the scenario settles), the peak kinetic
energy and when it happened, and the wall-clock time the run took on one core. Every run passes
its checks. The first run of tilting-floor and nerves-stand under the plausibility checks is this
one; before it, a scenario without a golden was not checked at all.

| Scenario | Golden | Range | Penetration | Drift | Energy rise | End kinetic | Peak kinetic | Wall clock |
|---|---|---|---|---|---|---|---|---|
| quiet-standing | yes | 0.178 | 14.2 | 0.0 | (driven) | 0.04 | 153 at 0.66 s | 7.8 s |
| tilting-floor | no | 0.073 | 8.2 | 0.0 | (driven) | 0.01 | 189 at 1.42 s | 15.2 s |
| drop-standing-collapse | yes | 0.077 | 10.1 | 0.0 | 4.37 (own limit 8) | 0.00 | 212 at 0.40 s | 0.6 s |
| drop-supine | yes | 0.047 | 8.5 | 0.0 | 0.00 | 0.00 | 244 at 0.28 s | 0.6 s |
| drop-prone | yes | 0.100 | 12.1 | 0.0 | 0.10 | 0.00 | 275 at 0.30 s | 0.6 s |
| stairs-tumble | yes | 0.142 | 10.4 | 0.0 | 2.21 (own limit 3; 1.00 before OQ-032) | 0.00 | 454 at 1.00 s | 0.8 s |
| hang-from-wrist | yes | 0.095 | 3.2 | 0.0 | (driven) | 0.00 | 130 at 0.24 s | 0.8 s |
| skull-wiggle | yes | 0.048 | 2.1 | 0.0 | (driven) | 0.51 (does not settle) | 20 at 0.20 s | 6.6 s |
| seated-on-box | yes | 0.045 | 8.7 | 0.0 | 0.00 | 0.00 | 190 at 0.40 s | 0.6 s |
| grab-and-swing | yes | 0.067 | 9.3 | 0.0 | (driven) | 0.00 | 161 at 0.40 s | 0.6 s |
| muscle-range-of-motion | yes | 0.107 | 5.4 | 0.0 | (driven) | 0.39 | 158 at 11.08 s | 30.4 s |
| arm-flail | yes | 0.079 | 5.1 | 0.0 | (driven) | 4.91 (does not settle) | 131 at 0.26 s | 18.0 s |
| clip-quiet-standing | yes | 0.049 | 11.0 | 0.0 | (driven) | 0.00 | 222 at 1.22 s | 14.9 s |
| clip-walk-normal | yes | 0.061 | 14.2 | 0.0 | (driven) | 0.43 (does not settle) | 430 at 1.26 s | 14.7 s |
| clip-flail-arms | yes | 0.086 | 7.5 | 0.0 | (driven) | 0.16 (does not settle) | 175 at 0.84 s | 18.9 s |
| nerves-stand | no | 0.164 | 20.7 | 0.0 | (driven) | 0.00 | 414 at 1.84 s | 25.1 s |

Every drift reading is below a ten-thousandth of a millimetre, which is what reduced coordinates
promise; the tolerance fell from 5 cm to 1 mm on the strength of it. The rest overrides the
driven scenarios carried (4 J to 80 J) are gone: six of the eight ended under a joule anyway,
because the body had fallen and lay still or the drive had wound down, and arm-flail, the one
still moving, now says it does not settle instead. grab-and-swing's 6 cm penetration allowance,
written for Rapier's impulse solver, is gone too: MuJoCo reaches 9.3 mm there. The four scenarios
marked as not settling are the ones whose drive runs to the last tick; three of them happen to
end under a joule today, but that is the fall or the amplitude, not rest, and the peak bound is
what holds them. The energy rises of the driven scenarios, up to 38.6 J in
muscle-range-of-motion, are the muscles' work and are not checked.

## Results, 2026-09-14, measured joint centres and the released scapula

Largest values seen per scenario on MuJoCo: range violation (rad), penetration (mm), joint
drift (mm), and kinetic energy at the end (J). Every run passes its checks; the numbers are kept
so the tolerances can be read against what they actually cover.

| Scenario | MuJoCo |
|---|---|
| drop-standing-collapse | 0.08 rad, 11 mm, 0.0 mm, 0.00 J |
| drop-supine | 0.07 rad, 11 mm, 0.0 mm, 0.00 J |
| drop-prone | 0.08 rad, 11 mm, 0.0 mm, 0.00 J |
| stairs-tumble | 0.07 rad, 12 mm, 0.0 mm, 0.00 J |
| hang-from-wrist | 0.17 rad, 6 mm, 0.0 mm, 0.01 J |
| seated-on-box | 0.07 rad, 15 mm, 0.0 mm, 0.53 J |
| grab-and-swing | 0.08 rad, 10 mm, 0.0 mm, 0.00 J |

The hip and shoulder centres moved to the middle of their articular spheres, 33 mm and 28 mm
from the surface markers that stood in for them before; the acromioclavicular and talonavicular
centres moved to where those bones actually touch; and the scapula gained the counter-rotations
that release it from the clavicle's swing. The scenarios run at L1, which has neither of the
last two, so they are unchanged by them. The body now lands harder in the
standing collapse, and the sample after peak compression returns about 5 J of the 230 J that
impact absorbs; that scenario carries its own energy tolerance with the reason beside it.

## Results, 2026-09-13, primitive proxies (before M5.8) -- history

Largest values seen per scenario and backend: range violation (rad), penetration (mm), joint
drift (mm), and kinetic energy at the end (J). This is the last run with both backends and the
conformance check between them; Rapier's tolerances then were 20 J, 0.5 rad and 4 cm. It is
kept as the record of the reassessment and will not be rerun.

| Scenario | Rapier | MuJoCo | Conformance |
|---|---|---|---|
| drop-standing-collapse | 0.44 rad, 27 mm, 0.3 mm, 0.00 J | 0.11 rad, 18 mm, 0.0 mm, 0.00 J | ok |
| drop-supine | 0.00 rad, 1 mm, 0.2 mm, 0.00 J | 0.06 rad, 8 mm, 0.0 mm, 0.00 J | ok |
| drop-prone | 0.04 rad, 4 mm, 0.1 mm, 0.00 J | 0.02 rad, 10 mm, 0.0 mm, 0.00 J | ok |
| stairs-tumble | 0.20 rad, 30 mm, 1.7 mm, 0.02 J | 0.09 rad, 10 mm, 0.0 mm, 0.00 J | ok, per-scenario tolerances |
| hang-from-wrist | 0.37 rad, 26 mm, 0.7 mm, 0.09 J | 0.12 rad, 13 mm, 0.0 mm, 0.00 J | ok |
| seated-on-box | 0.05 rad, 7 mm, 0.4 mm, 0.06 J | 0.04 rad, 24 mm, 0.0 mm, 0.03 J | ok |
| grab-and-swing | 0.36 rad, 14 mm, 1.0 mm, 0.00 J | 0.06 rad, 9 mm, 0.0 mm, 0.00 J | ok |

The Rapier stop yields (up to 0.44 rad at the ankle in the standing collapse, 0.37 rad at the
hanging shoulder) are the subject of OQ-009. Joint couplings (M5.2) run natively on MuJoCo and
ran as one-way soft corrections on Rapier, whose work is subtracted in the energy balance. The
stairs scenario carried its own conformance tolerance, with the reason in its definition: which
step a body stops on is chaotic, so resting heights could differ by up to 0.6 m between backends.
