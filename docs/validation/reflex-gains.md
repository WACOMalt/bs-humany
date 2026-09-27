# What the cord's gains are worth, measured

The spinal module has seven numbers and not one of them is trained. Evolution Strategies searches
the policy's weights -- 27142 of them for a 742 x 32 x 32 x 70 network -- and the cord is part of
the body those weights are searched against, fixed for the whole run by the recipe or the
`--reflex*` flags and saved with the checkpoint so the studio can set itself up the same way.

So they are chosen by measurement, and this is the measurement.

Every number here that a cord could change was measured twice, on two cords, and both are given.
**Per side and per unit** is the cord as it is built today, the owner's decision of 2026-09-26:
each unit's stretch, velocity and Golgi terms drive that unit alone, and reciprocal inhibition is
worked out per reflex group -- `reflexGroups()` in `packages/scenarios/src/muscleGroups.ts`, one
side of one drive group each, seventy of them -- a group's mean drive taking a share off every unit
of its antagonist on the same side. **Pooled** is the cord before it: thirty-five groups each
holding both sides of the body, every term averaged over the group and that mean applied to all of
its units, so a stretched left soleus excited the right one as much as itself. The pooled numbers
are the ones the gains were first chosen on, and they are kept beside the new ones because the
choice was made on them. Stretch and velocity both at 0 switch the whole cord off, Golgi term
included, on either cord. The measured gains are `MEASURED_SPINAL_GAINS` in
`packages/modules-nerves/src/spinalModule.ts`, which the recipe's `DEFAULT_REFLEX` copies and a
test holds it to.

The delay, 0.03 s throughout, was not measured here and is not sourced either: it is
`SPINAL_CONDUCTION_DELAY_S`, and OQ-031 in `docs/sources/open-questions.md` records that it and
the gains are chosen rather than taken from a source.

## First, the afferent was wrong

`muscle.state` publishes fibre length already normalised -- the channel's own word for its unit is
"optimal fiber lengths" -- so 1 is a fibre at its optimal length. The cord divided it by the
optimal fibre length **in metres** as well. The signal it reacted to therefore ran from 2.3 to 41
where the strain runs from -0.44 to 0, and every muscle in the body read as hugely stretched at
every instant, standing perfectly still included.

That is not a stretch reflex. It is a constant tone, and one proportional to one over the muscle's
fibre length, so the shortest-fibred muscles got the most of it. It is also the whole explanation
for the gains that used to be here: five thousandths was as much as could be applied before the
tone saturated the body, and eight tenths put 94 per cent of its muscles at full excitation.

Fixed, the length afferent is `fiberLength - 1`, and this is what the body actually presents:

| | p05 | p50 | p95 | max |
|---|---|---|---|---|
| standing, the first moment | -0.440 | -0.053 | -0.004 | 0.023 |
| three seconds into a collapse | -0.501 | -0.111 | 0.118 | 0.386 |

This and the next table are read with no cord at all, so they are the body's and neither cord's.

## The set point, which decides whether it is a reflex at all

Muscles past the set point, of 272:

| set point | standing still | falling |
|---|---|---|
| -0.10 (the old default) | **173** | 123 |
| -0.05 | 135 | 101 |
| **0.00** | **2** | 61 |
| +0.05 | 0 | 26 |

At -0.10 two thirds of the body is excited while it stands perfectly still. At 0 -- hold the fibre
at its optimal length -- the cord is quiet until something is actually stretched, and 61 muscles
answer as the body goes down.

Swept for time upright, the policy silent, stretch 3, damper 0.5:

| set point | per side and per unit | pooled |
|---|---|---|
| -0.06 | 0.571 | 0.504 |
| -0.02 | 0.578 | 0.544 |
| **0** | **0.611** | 0.578 |
| +0.02 | 0.594 | level with 0 |

On the pooled cord it was a plateau from 0 to +0.02, falling off below; the value at +0.02 was not
written down, only that it was level with 0. On the cord as built it is a
peak at 0, which is the set point already in use.

## The gains, under a trained policy

Eight seeds, six-second episodes, the committed standing policy loaded, damper 0.5:

| stretch | seconds upright | fitness | silent: seconds upright | pooled: seconds upright | pooled: fitness |
|---|---|---|---|---|---|
| 0 (no cord) | 0.456 | 0.967 | 0.484 | 0.456 | 0.967 |
| 2 | 0.730 | 1.541 | 0.595 | 0.639 | 1.343 |
| 2.5 | 0.773 | 1.623 | 0.605 | 0.736 | 1.518 |
| 3 | 0.800 | 1.675 | 0.611 | 0.859 | 1.714 |
| **3.5** | **0.819** | **1.709** | 0.615 | **0.894** | **1.751** |
| 4 | 0.836 | 1.739 | 0.620 | 0.904 | 1.797 |
| 5 | 0.852 | 1.764 | 0.628 | 0.851 | 1.712 |

The first three columns are the cord as built; the last two are the pooled cord, on which the
default of 3.5 was chosen, off the measured argmax of an eight-seed estimate and with room on both
sides. The pooled cord's silent body peaked lower and flatter -- 0.484 s with no cord, 0.568 from
stretch 2 to 4 -- which is the sense in which the cord is a floor rather than a controller, and on
the cord as built that is still so.

The two cords do not tell the same story. On the pooled cord time upright peaked between 3.5 and 4
and fell off past it: the brain adds its correction to what the cord has already put on the muscle,
and a muscle clamped at 1 eats it. On the cord as built it is lower at every stretch up to 4 and
still rising at 5, the edge of the sweep, by about 0.017 s a half step. That is what the change
should do: a unit now answers only its own stretch, not the mean of its group's and the other
leg's, so less of the body is driven towards the ceiling at any gain, and the ceiling is reached
later. A reflex that silences the policy is still worse than no reflex; it happens further up.

**The default is still 3.5**, and not because the new table chose it. This sweep has no peak to
choose -- its best row is the last one it measured -- and a default on the edge of a sweep is a
guess about what lies past it. The policy it is measured under, too, was trained with no cord at
all, and the five shipped policies are to be retrained and this page measured again (owner's
decision of 2026-09-26); a sweep past 5 belongs with that measurement, under a policy that learnt
over this cord. Until then 3.5 is inside the range where the cord as built is worth most of what it
is worth -- 0.819 s against 0.456 with no cord, 0.852 at the best row -- and it is not in the
region the pooled cord showed to be harmful.

## The damper

The velocity afferent is `fiberVelocity`, a fraction of the unit's maximum contraction velocity (10
optimal lengths a second for every unit), and it reaches 0.044 of that maximum -- about 0.44
optimal lengths a second -- in a fall where stretch reaches 0.39, so at any gain comparable to the
stretch gain the term is small.

At stretch 3:

| velocity gain | trained | silent | pooled: trained | pooled: silent |
|---|---|---|---|---|
| 0 | 0.761 | 0.575 | 0.876 | 0.573 |
| 0.5 | 0.800 | 0.611 | 0.859 | 0.578 |
| 2 | | 0.609 | | 0.524 |
| 4 | | 0.371 | | 0.388 |
| 8 | | 0.175 | | 0.268 |

On the pooled cord it was nearly neutral, a little help to the silent body and a little cost to the
trained one. Per unit it helps both, by 0.04 s: a unit's velocity term is its own, no longer
averaged away over a group that is mostly not moving. What it prevents is plain further out either
way. A length loop with a conduction delay in it rings, and past 2 the ringing is the whole story.
The useful range is narrow and below 2, and a quarter sits inside it.

## Reciprocal inhibition, which this measure cannot choose

Silent, stretch 3, damper 0.5:

| inhibition | per side and per unit | pooled |
|---|---|---|
| 0 | 0.584 | 0.546 |
| 0.30 | 0.611 | 0.578 |
| 0.80 | 0.645 | 0.609 |
| 1.00 | 0.655 | 0.619 |
| 1.50 | 0.678 | 0.635 |
| 3.00 | 0.728 | 0.684 |

On both cords it rises monotonically straight past every value that means anything. More inhibition
is less muscle doing less, and a limper body takes longer to fall -- so time upright is measuring
slackness here, not the reflex. 1 is the physiological statement, that the antagonist's reflex is
fully cancelled; 0.3 is what is set, unchanged and unclaimed. Choosing between them wants two
training runs, not a table.

## The Golgi ceiling, which never fires

Tendon force over maximum isometric force reaches 0.042 at the 95th percentile and 0.235 at worst
in a full collapse, against a ceiling of 1.2. The autogenic term contributes exactly nothing to
any measurement on this page -- on the cord as built, the trained body is 0.819 s upright and the
silent one 0.611 with it on and with it off, and the pooled cord's two rows were identical to three
decimals too. It is left where it is because nothing here exercises it, not because it has been
shown to be right.

## Reproducing all of it

`pnpm measure:reflex-gains` (`tools/train/bin/measure-reflex-gains.mjs`) prints these tables and
writes nothing; `--tables stretch` or `--seeds 2` makes a shorter run of it, and the whole of it
takes about half an hour. It measures whatever cord `SpinalModule` and `reflexGroups()` build, so
it now reproduces the per-side-and-per-unit columns, and the pooled columns need the tree as it was
before the cord was split (8cc1e95).

Run on 2026-09-27 on the cord as built, it gave every per-side-and-per-unit number on this page. On
the pooled cord, the same day, it gave every pooled time-upright number to the third decimal, with
two exceptions in the last place: fitness at stretch 3 is 1.711 and the trained body with no damper
0.875. The pooled silent column of its stretch table runs from 0.579 at 2 to 0.569 at 4. What it
does not reproduce is the collapse: the standing row and the standing column agree, but the falling
row, the falling column and the Golgi's tendon forces were measured in a collapse whose recipe was
not written down. The script's collapse -- the reference stand, silent, no cord, seed 1 -- gives
-0.414, -0.136, 0.148 and 0.323 for the row, 114, 97, 57 and 35 for the column, and 0.084 and 0.362
for the tendon force, still far below the ceiling of 1.2. Those are the same on both cords, since
the collapse has no cord in it.

It does what follows. Build a `StandRig` per setting with `reflex: { ...DEFAULT_REFLEX, ... }`, run
`episode` over several seeds, and read `aliveSeconds`. For a trained body, `MlpPolicy.fit` the
checkpoint against `rig.inputNames` and `rig.outputNames` first. The flags do the same for a real
run: `--reflex`, `--reflex-velocity`, `--reflex-setpoint`, `--reflex-inhibition`,
`--reflex-ceiling`, `--reflex-force-inhibition`, `--reflex-delay`.

## Making them trainable

`SpinalModule.gains` has a setter and `StandRig` exposes its cord, so the seven numbers could be
appended to the search vector and set per candidate. Nothing is stopping it but the decision: it
adds seven dimensions to a search over 27142 and changes what a checkpoint means, since the cord
would then be part of what was learnt rather than part of the body it was learnt in.
