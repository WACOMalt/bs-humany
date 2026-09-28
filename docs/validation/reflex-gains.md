# What the cord's gains are worth, measured

The spinal module has seven numbers, and a stretch gain for each region of the body, and not one
of them is trained. Evolution Strategies searches
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

The per-side-and-per-unit numbers were measured a second time on 2026-09-27, on the body as it is
now, and every one of them on this page is from that run. The first run of that cord was on a body
from before the anatomy data fixes of the same day (the forearm's axis and range, the re-admitted
units, the translated fibre lengths, the derived landmarks) and before the wrist's clinical
deviation range; the body moved under it, and the second stretch sweep went past 5, so the whole
page was measured again rather than only the rows that were new. How much the body moved it is in
the stretch section.

*2026-09-27, later the same day:* every "trained" row on this page was measured under `stand.json`,
the standing policy the owner retired that day with the four other shipped checkpoints, and before
the sense fixes (the policy's frame rotation, its strain and foot-weight senses, and the one clamp
on the summed drive); the numbers stand as measured, and the page is to be measured again, with
`pnpm measure:reflex-gains`, under the shipped `balance` once it has been trained further.

*2026-09-28:* the stretch differs by region, the owner's decision of 2026-09-27 after the arms
shook at 8.5 everywhere. The section [The stretch by region](#the-stretch-by-region-chosen-on-tremor-too)
has the sweep, the rule that chose each region's gain, and the cord so chosen beside the old one;
the tables above and below it are of one stretch everywhere, as they were measured.

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
| standing, the first moment | -0.484 | -0.057 | -0.004 | 0.023 |
| three seconds into a collapse | -0.437 | -0.136 | 0.147 | 0.324 |

This and the next table are read with no cord at all, so they are the body's and neither cord's.
The collapse is the script's: the reference stand, silent, no cord, seed 1.

## The set point, which decides whether it is a reflex at all

Muscles past the set point, of 272:

| set point | standing still | falling |
|---|---|---|
| -0.10 (the old default) | **166** | 110 |
| -0.05 | 127 | 94 |
| **0.00** | **2** | 54 |
| +0.05 | 0 | 35 |

At -0.10 well over half the body is excited while it stands perfectly still. At 0 -- hold the fibre
at its optimal length -- the cord is quiet until something is actually stretched, and 54 muscles
answer as the body goes down.

Swept for time upright, the policy silent, stretch 3, damper 0.5:

| set point | per side and per unit | pooled |
|---|---|---|
| -0.06 | **0.766** | 0.504 |
| -0.02 | 0.617 | 0.544 |
| **0** | **0.619** | 0.578 |
| +0.02 | 0.590 | level with 0 |

On the pooled cord it was a plateau from 0 to +0.02, falling off below; the value at +0.02 was not
written down, only that it was level with 0. On the cord as first built, before the anatomy fixes,
it was a peak at 0 (0.571, 0.578, 0.611, 0.594 down this column). On the body as it is now it is
not: -0.06 keeps the silent body up 0.15 s longer than 0 does. The set point stays at 0 all the
same, because this measure cannot tell a reflex from a tone: at -0.06 more than a hundred muscles
are past it standing still, and a body with a constant tone in most of its muscles is a stiffer
body that takes longer to fall, which is what time upright rewards. That is the same reason this
page gives for not choosing inhibition by it, below. Whether a trained body wants a tone is a
question for training runs, not this table.

## The gains, under a trained policy

Eight seeds, six-second episodes, the committed standing policy loaded, damper 0.5:

| stretch | seconds upright | fitness | silent: seconds upright | pooled: seconds upright | pooled: fitness |
|---|---|---|---|---|---|
| 0 (no cord) | 0.433 | 0.914 | 0.480 | 0.456 | 0.967 |
| 2 | 0.658 | 1.403 | 0.598 | 0.639 | 1.343 |
| 2.5 | 0.705 | 1.502 | 0.606 | 0.736 | 1.518 |
| 3 | 0.750 | 1.592 | 0.619 | 0.859 | 1.714 |
| 3.5 | 0.788 | 1.666 | 0.624 | **0.894** | **1.751** |
| 4 | 0.813 | 1.713 | 0.633 | 0.904 | 1.797 |
| 4.5 | 0.836 | 1.755 | 0.638 | | |
| 5 | 0.860 | 1.797 | 0.642 | 0.851 | 1.712 |
| 5.5 | 0.881 | 1.832 | 0.647 | | |
| 6 | 0.898 | 1.853 | 0.652 | | |
| 6.5 | 0.911 | 1.869 | 0.656 | | |
| 7 | 0.925 | 1.883 | 0.660 | | |
| 7.5 | 0.934 | 1.891 | 0.664 | | |
| 8 | 0.943 | 1.899 | 0.670 | | |
| **8.5** | **0.953** | **1.908** | 0.671 | | |
| 9 | 0.955 | 1.905 | 0.675 | | |
| 9.5 | 0.959 | 1.903 | 0.676 | | |
| 10 | 0.959 | 1.896 | 0.680 | | |

The first four columns are the cord as built; the last two are the pooled cord, on which the first
default of 3.5 was chosen, off the measured argmax of an eight-seed estimate and with room on both
sides. The pooled cord's silent body peaked lower and flatter -- 0.484 s with no cord, 0.568 from
stretch 2 to 4 -- which is the sense in which the cord is a floor rather than a controller, and on
the cord as built that is still so.

The two cords do not tell the same story. On the pooled cord time upright peaked between 3.5 and 4
and fell off past it: the brain adds its correction to what the cord has already put on the muscle,
and a muscle clamped at 1 eats it. On the cord as built there is no fall-off anywhere in the sweep.
Time upright climbs by about 0.02 s a half step to 6, more slowly after, and levels off from 8.5:
0.953 there, 0.955 at 9, 0.959 at 9.5 and at 10. Fitness, the score the trainer searches on,
peaks at 8.5, at 1.908, and falls a little past it. That is what the change should do: a unit now
answers only its own stretch, not the mean of its group's and the other leg's, so less of the body
is driven towards the ceiling at any gain, and the ceiling is reached much later. A reflex that
silences the policy is still worse than no reflex; on this cord it has not happened by 10.

**The default is 8.5.** The best time upright in the sweep is 0.959, at 9.5 and at 10, and the top
four rows lie within 0.006 s of each other, which eight seeds do not separate. Where the curve is
that flat the rule is to take the smallest gain within 1% of the best: that is 8.5 (0.953, 0.6%
below), where 8 is 1.7% below. It is also the gain at which fitness peaks, so the two measures agree
on it. It moved from 3.5 on 2026-09-27, the owner's decision being to move it on this sweep rather
than wait for the retrained policies (ADR-014). The committed standing policy it is measured under
was trained with no cord at all; the five shipped policies are retrained over this cord in the next
wave, and a policy that has learnt over it may find the fall-off somewhere this one does not. The
studio's and the headset's Stretch slider, and the recipe's limit on it, went from 8 to 10 so that
the default sits inside them.

How much of the difference from the first run of this cord is the body: at stretch 3.5 the trained
body was 0.819 s upright on the tree the cord was first measured on, 0.781 on the tree after the
anatomy data fixes had merged (a1c7e9f), and 0.788 after the wrist's clinical range. At 8.5 it was
0.945 on a1c7e9f against 0.953 now. So nearly all of the drop in the low rows is the data fixes,
the wrist gives back a little of it, and neither moves where the curve levels off.

## The stretch by region, chosen on tremor too

The owner watched the arms shake at the default of 8.5 everywhere, and asked whether 8.5 was too
high. Measured on the studio's default scene -- "Drop, standing" at 0 m, L3, the muscles, no
policy, seconds 0.5 to 3 -- with tremor as the root mean square of each joint velocity less its own
0.2 s moving average, it was: the arms' tremor rose with the stretch from 1.64 rad/s with no stretch
gain to 6.08 at 8.5, their joints reversing 6.3 times a second each against 3.4, while the legs'
hardly moved past 2 (0.82 to 0.89). 8.5 had been chosen on time upright alone, under the retired
standing policy, and time upright cannot see a limb shaking. The owner chose a stretch by region:
stiff where posture needs it, gentle where it only makes tremor. The regions are the drive
sections the muscle groups already declare -- arm, hand, leg, trunk, neck -- and a unit answers its
spindle with its region's gain (`SpinalGains.regionStretch`); a cord that names no regions, as every
recipe, checkpoint and session before this does, is its one stretch everywhere.

**How it was measured.** Each region's stretch was swept from 0 to 10 with every other region at 5,
the middle of the range. Time upright is the rig's, on the default behaviour's body -- "Drop,
standing" at 0 m, L3, with training's tremor, grain and twitch -- over eight seeds of six seconds,
under `balance.json` as committed before this change (trained five generations on 8.5 everywhere)
and silent. Tremor is the studio's own session on the same scene, with none of those disturbances,
silent and with `balance.json` handed over; the region's joints are the arm's shoulder girdle,
shoulder, elbow, forearm and wrist, the hand's finger and thumb joints, the leg's hip, knee,
kneecap, ankle, foot and toes, the trunk's lumbar and thoracic joints, and the neck's cervical ones.

**The rule.** Of the gains whose tremor, trained and silent, stays within 20% of the region's
tremor with its own stretch at 0, and whose time upright, trained and silent, is within 2% of the
region's best, take the smallest: the least cord that holds the body up as well as any does
without shaking it, for the reason the single stretch was the smallest gain within 1% of the best.
Where no gain meets both, tremor wins: of the gains inside the tremor bound, the one that keeps the
trained body up longest. The script applies it and prints the verdict below.

### The stretch gain by region, 8 seeds, others at 5

| region | stretch | trained: seconds upright | silent: seconds upright | trained: tremor rad/s | silent: tremor rad/s |
|---|---|---|---|---|---|
| Arm | 0 | 0.500 | 0.470 | 1.804 | 1.848 |
| Arm | 1 | 0.566 | 0.473 | 1.803 | 1.695 |
| Arm | 2 | 0.576 | 0.475 | 2.055 | 2.124 |
| Arm | 3.5 | 0.589 | 0.553 | 1.781 | 1.652 |
| Arm | 5 | 0.595 | 0.555 | 2.273 | 2.311 |
| Arm | 6.5 | 0.599 | 0.563 | 3.583 | 3.721 |
| Arm | 8.5 | 0.606 | 0.570 | 4.637 | 4.081 |
| Arm | 10 | 0.606 | 0.571 | 4.979 | 4.636 |
| Hand | 0 | 0.594 | 0.554 | 0.807 | 1.181 |
| Hand | 1 | 0.594 | 0.555 | 0.727 | 0.888 |
| Hand | 2 | 0.594 | 0.555 | 0.756 | 0.832 |
| Hand | 3.5 | 0.595 | 0.555 | 0.756 | 1.079 |
| Hand | 5 | 0.595 | 0.555 | 0.837 | 0.952 |
| Hand | 6.5 | 0.594 | 0.555 | 0.844 | 0.839 |
| Hand | 8.5 | 0.594 | 0.556 | 0.838 | 0.932 |
| Hand | 10 | 0.594 | 0.556 | 0.824 | 0.937 |
| Leg | 0 | 0.443 | 0.424 | 0.980 | 0.945 |
| Leg | 1 | 0.455 | 0.436 | 1.143 | 0.969 |
| Leg | 2 | 0.469 | 0.446 | 0.727 | 0.918 |
| Leg | 3.5 | 0.576 | 0.464 | 1.051 | 1.052 |
| Leg | 5 | 0.595 | 0.555 | 1.218 | 1.132 |
| Leg | 6.5 | 0.610 | 0.571 | 1.248 | 1.112 |
| Leg | 8.5 | 0.625 | 0.585 | 1.356 | 1.323 |
| Leg | 10 | 0.714 | 0.589 | 1.519 | 1.366 |
| Trunk | 0 | 0.495 | 0.465 | 0.105 | 0.099 |
| Trunk | 1 | 0.497 | 0.470 | 0.106 | 0.104 |
| Trunk | 2 | 0.568 | 0.471 | 0.106 | 0.099 |
| Trunk | 3.5 | 0.584 | 0.479 | 0.106 | 0.101 |
| Trunk | 5 | 0.595 | 0.555 | 0.109 | 0.101 |
| Trunk | 6.5 | 0.601 | 0.561 | 0.109 | 0.099 |
| Trunk | 8.5 | 0.608 | 0.569 | 0.110 | 0.100 |
| Trunk | 10 | 0.611 | 0.576 | 0.107 | 0.103 |
| Neck | 0 | 0.595 | 0.556 | 0.169 | 0.178 |
| Neck | 1 | 0.596 | 0.556 | 0.161 | 0.172 |
| Neck | 2 | 0.595 | 0.555 | 0.156 | 0.178 |
| Neck | 3.5 | 0.595 | 0.556 | 0.155 | 0.182 |
| Neck | 5 | 0.595 | 0.555 | 0.158 | 0.185 |
| Neck | 6.5 | 0.594 | 0.555 | 0.165 | 0.191 |
| Neck | 8.5 | 0.594 | 0.555 | 0.157 | 0.188 |
| Neck | 10 | 0.593 | 0.555 | 0.175 | 0.191 |

### The gains the rule chooses

- **Arm 3.5**: no gain keeps both. Of those within 20% of the tremor with no cord, this one keeps the trained body up longest (0.589 s trained, 0.553 silent); its tremor with no cord of its own is 1.804 trained and 1.848 silent, and its best time upright 0.606 s trained and 0.571 silent.
- **Hand 0**: the smallest gain within 20% of that tremor and 2% of that time upright (0.594 s trained, 0.554 silent); its tremor with no cord of its own is 0.807 trained and 1.181 silent, and its best time upright 0.595 s trained and 0.556 silent.
- **Leg 3.5**: no gain keeps both. Of those within 20% of the tremor with no cord, this one keeps the trained body up longest (0.576 s trained, 0.464 silent); its tremor with no cord of its own is 0.980 trained and 0.945 silent, and its best time upright 0.714 s trained and 0.589 silent.
- **Trunk 8.5**: the smallest gain within 20% of that tremor and 2% of that time upright (0.608 s trained, 0.569 silent); its tremor with no cord of its own is 0.105 trained and 0.099 silent, and its best time upright 0.611 s trained and 0.576 silent.
- **Neck 0**: the smallest gain within 20% of that tremor and 2% of that time upright (0.595 s trained, 0.556 silent); its tremor with no cord of its own is 0.169 trained and 0.178 silent, and its best time upright 0.596 s trained and 0.556 silent.

### The cord so chosen, beside none and the old one

Tremor in rad/s, trained / silent.

| cord | trained: seconds upright | silent: seconds upright | Arm | Hand | Leg | Trunk | Neck |
|---|---|---|---|---|---|---|---|
| no cord | 0.413 | 0.399 | 1.157 / 1.237 | 0.668 / 0.538 | 0.823 / 0.675 | 0.089 / 0.077 | 0.192 / 0.211 |
| 8.5 everywhere | 0.734 | 0.607 | 4.155 / 4.296 | 1.545 / 1.648 | 1.338 / 1.277 | 0.116 / 0.141 | 0.228 / 0.214 |
| by region, as chosen | 0.585 | 0.469 | 1.521 / 1.712 | 0.680 / 0.597 | 1.106 / 1.052 | 0.089 / 0.085 | 0.121 / 0.122 |

**What the numbers say.** The trunk is where a stiff cord is free: its tremor does not move with
its gain at all, and its time upright climbs to 8.5 and levels, so it keeps 8.5. The hands and the
neck are where the cord buys nothing either way -- time upright and tremor flat across the whole
range -- so they get none of their own, and their damping still answers. The arms and the legs are
the hard ones: in both, a stiffer cord holds the body up longer and shakes the limb more, and no
gain does both inside the bounds. The arms' tremor is flat to 3.5 and then rises steeply, nearly
three times over by 10, so 3.5 is where the rule stops. The legs, contrary to what was expected of
them, came out the same way: their time upright climbs all the way to 10, but their tremor rises with it,
reaching 38% over their tremor with no stretch at 8.5, and by the rule tremor wins there too. That
rise is partly a body that stays up longer moving more in the window the tremor is read over rather
than a leg that shakes, which the measure cannot tell apart; the owner's probe of the old cord shows
the legs reversing twice as often at 8.5 as at the new defaults (2.1 against 1.1 a second), so it
is not all of it.

**What it costs.** Against 8.5 everywhere, the cord by region brings the arms' tremor from 4.2 rad/s
to 1.5, 31% over the tremor with no cord at all where 8.5 was 259% over; the legs' from 1.3 to
1.1, and the trunk's and neck's to or below where they are with no cord. It gives back time
upright, 0.585 s under the committed policy against 0.734, most of it the legs' 3.5. Whether to buy that back with a stiffer
leg, at the price of the legs' tremor, is a choice the rule does not make and the owner can: the
Spine panel's Leg slider, or `--reflex-stretch-leg`, sets it alone.

The owner's own probe, the table that started this (arm = elbow, forearm and wrist; leg = hip and
knee; no redistribution), at the new defaults:

| cord | arm tremor rad/s | arm reversals /s/DoF | leg tremor rad/s | leg reversals /s/DoF |
|---|---|---|---|---|
| no stretch, damping 0.25 | 1.64 | 3.4 | 0.59 | 0.9 |
| 8.5 everywhere | 6.08 | 6.3 | 0.89 | 2.1 |
| **by region** | **2.39** | **2.8** | **0.85** | **1.1** |

The damping stays one number. The arms' reversals at the new defaults are fewer than with no
stretch gain at all, so nothing here asks for a damping by region.

**The balance checkpoint** was trained over 8.5 everywhere, and was re-saved on this cord the way
it first was: five generations of the default behaviour, `pnpm train:nerves --force --generations
5` into a scratch data directory, centre 0.536 at 0.83 s up. It is still only there to be trained
on. These tables were measured under the checkpoint as it was before, the policy committed when
they were taken; the next measurement of this page is under the re-saved one.

## The damper

The velocity afferent is `fiberVelocity`, a fraction of the unit's maximum contraction velocity (10
optimal lengths a second for every unit), and it reaches 0.044 of that maximum -- about 0.44
optimal lengths a second -- in a fall where stretch reaches 0.39, so at any gain comparable to the
stretch gain the term is small.

At stretch 3:

| velocity gain | trained | silent | pooled: trained | pooled: silent |
|---|---|---|---|---|
| 0 | 0.731 | 0.585 | 0.876 | 0.573 |
| 0.5 | 0.750 | 0.619 | 0.859 | 0.578 |
| 2 | | 0.595 | | 0.524 |
| 4 | | 0.359 | | 0.388 |
| 8 | | 0.194 | | 0.268 |

On the pooled cord it was nearly neutral, a little help to the silent body and a little cost to the
trained one. Per unit it helps both, the trained body by 0.02 s and the silent one by 0.03: a unit's velocity term is its own, no
longer averaged away over a group that is mostly not moving. What it prevents is plain further out
either way. A length loop with a conduction delay in it rings, and past 2 the ringing is the whole
story. The useful range is narrow and below 2, and a quarter sits inside it.

## Reciprocal inhibition, which this measure cannot choose

Silent, stretch 3, damper 0.5:

| inhibition | per side and per unit | pooled |
|---|---|---|
| 0 | 0.591 | 0.546 |
| 0.30 | 0.619 | 0.578 |
| 0.80 | 0.650 | 0.609 |
| 1.00 | 0.660 | 0.619 |
| 1.50 | 0.683 | 0.635 |
| 3.00 | 0.736 | 0.684 |

On both cords it rises monotonically straight past every value that means anything. More inhibition
is less muscle doing less, and a limper body takes longer to fall -- so time upright is measuring
slackness here, not the reflex. 1 is the physiological statement, that the antagonist's reflex is
fully cancelled; 0.3 is what is set, unchanged and unclaimed. Choosing between them wants two
training runs, not a table.

## The Golgi ceiling, which never fires

Tendon force over maximum isometric force reaches 0.083 at the 95th percentile and 0.359 at worst
in a full collapse, against a ceiling of 1.2. The autogenic term contributes exactly nothing to
any measurement on this page -- on the cord as built, the trained body at the default stretch of
8.5 is 0.953 s upright and the silent one at stretch 3 is 0.619, with it on and with it off, and
the pooled cord's two rows were identical to three decimals too. It is left where it is because
nothing here exercises it, not because it has been shown to be right.

## Reproducing all of it

`pnpm measure:reflex-gains` (`tools/train/bin/measure-reflex-gains.mjs`) prints these tables and
writes nothing; `--tables stretch` or `--seeds 2` makes a shorter run of it. The stretch table alone
is thirty-six settings and took about thirteen minutes on 2026-09-27; the rest of the tables took
about six and a half. It measures whatever cord `SpinalModule` and `reflexGroups()` build and whatever body
the tree holds, so it reproduces the per-side-and-per-unit columns, and the pooled columns need the
tree as it was before the cord was split (8cc1e95).

Run on 2026-09-27 on the body after the wrist's clinical range, it gave every per-side-and-per-unit
number on this page: the stretch table with the default still at 3.5, and the other tables after
it moved to 8.5, which only the Golgi table's trained column reads. The collapse the afferent
table, the falling column and the tendon forces are read in is now the script's own, so every
number on the page is one it prints. The first run of the pooled cord's collapse was not written
down, and the pooled columns never needed it.

It does what follows. Build a `StandRig` per setting with `reflex: { ...DEFAULT_REFLEX, ... }`, run
`episode` over several seeds, and read `aliveSeconds`. For a trained body, `MlpPolicy.fit` the
checkpoint against `rig.inputNames` and `rig.outputNames` first. The flags do the same for a real
run: `--reflex` (the stretch in every region), `--reflex-stretch-arm`, `--reflex-stretch-hand`,
`--reflex-stretch-leg`, `--reflex-stretch-trunk`, `--reflex-stretch-neck`, `--reflex-velocity`,
`--reflex-setpoint`, `--reflex-inhibition`, `--reflex-ceiling`, `--reflex-force-inhibition`,
`--reflex-delay`.

The region tables are `--tables regions`. They read tremor off the studio's own session
(`Simulation` in `packages/session`) rather than the rig, because the rig's episodes carry
training's tremor, grain and twitch and the studio's run carries none of them: what shook was the
studio's body, and that is the body the tremor is measured on.

## Making them trainable

`SpinalModule.gains` has a setter and `StandRig` exposes its cord, so the seven numbers could be
appended to the search vector and set per candidate. Nothing is stopping it but the decision: it
adds seven dimensions to a search over 27142 and changes what a checkpoint means, since the cord
would then be part of what was learnt rather than part of the body it was learnt in.
