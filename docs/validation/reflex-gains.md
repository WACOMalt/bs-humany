# What the cord's gains are worth, measured

The spinal module has seven numbers and not one of them is trained. Evolution Strategies searches
the policy's weights -- 27142 of them for a 742 x 32 x 32 x 70 network -- and the cord is part of
the body those weights are searched against, fixed for the whole run by the recipe or the
`--reflex*` flags and saved with the checkpoint so the studio can set itself up the same way.

So they are chosen by measurement, and this is the measurement.

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
answer as the body goes down. Swept for time upright it is a plateau from 0 to +0.02 and falls off
below: 0.578 s at 0, 0.544 at -0.02, 0.504 at -0.06.

## The gains, under a trained policy

Eight seeds, six-second episodes, the committed standing policy loaded, damper 0.5:

| stretch | seconds upright | fitness |
|---|---|---|
| 0 (no cord) | 0.456 | 0.967 |
| 2 | 0.639 | 1.343 |
| 2.5 | 0.736 | 1.518 |
| 3 | 0.859 | 1.714 |
| **3.5** | **0.894** | **1.751** |
| 4 | 0.904 | 1.797 |
| 5 | 0.851 | 1.712 |

The peak is broad across 3.5 to 4 and the default is 3.5, off the measured argmax of an eight-seed
estimate and with room on both sides. The fall-off past it is the excitation ceiling: the brain
adds its correction to what the cord has already put on the muscle, and a muscle clamped at 1 eats
it. A reflex that silences the policy is worse than no reflex, and that much was always true.

The same numbers with the policy silent peak lower and flatter -- 0.484 s with no cord, 0.568 at
stretch 2 to 4 -- which is the sense in which the cord is a floor rather than a controller.

## The damper

Nearly neutral at these gains, and kept for what it is for. Fibre velocity reaches 0.044 optimal
lengths a second in a fall where stretch reaches 0.39, so the term is small either way: it is
worth a little to a silent body (0.578 s at 0.5 against 0.573 at 0) and costs a little to a
trained one (0.859 at 0.5 against 0.876 at 0).

What it prevents is plain further out. A length loop with a conduction delay in it rings, and past
2 the ringing is the whole story: 0.524 s upright at 2, 0.388 at 4, 0.268 at 8, against 0.573 with
no damping at all. The useful range is narrow and below 1, and a quarter sits inside it.

## Reciprocal inhibition, which this measure cannot choose

| inhibition | seconds upright |
|---|---|
| 0 | 0.546 |
| 0.30 | 0.578 |
| 0.80 | 0.609 |
| 1.00 | 0.619 |
| 1.50 | 0.635 |
| 3.00 | 0.684 |

It rises monotonically straight past every value that means anything. More inhibition is less
muscle doing less, and a limper body takes longer to fall -- so time upright is measuring
slackness here, not the reflex. 1 is the physiological statement, that the antagonist's reflex is
fully cancelled; 0.3 is what is set, unchanged and unclaimed. Choosing between them wants two
training runs, not a table.

## The Golgi ceiling, which never fires

Tendon force over maximum isometric force reaches 0.042 at the 95th percentile and 0.235 at worst
in a full collapse, against a ceiling of 1.2. The autogenic term contributes exactly nothing to
any measurement on this page -- the two rows for it are identical to three decimals. It is left
where it is because nothing here exercises it, not because it has been shown to be right.

## Reproducing all of it

`pnpm measure:reflex-gains` (`tools/train/bin/measure-reflex-gains.mjs`) prints these tables and
writes nothing; `--tables stretch` or `--seeds 2` makes a shorter run of it, and the whole of it
takes about half an hour. Run on 2026-09-27 it gave every time-upright number on this page to the
third decimal, with two exceptions in the last place: fitness at stretch 3 is 1.711 and the
trained body with no damper 0.875. The silent column of its stretch table runs from 0.579 at 2 to
0.569 at 4. What it does not reproduce is the collapse: the standing row and the standing column
agree, but the falling row, the falling column and the Golgi's tendon forces were measured in a
collapse whose recipe was not written down. The script's collapse -- the reference stand, silent,
no cord, seed 1 -- gives -0.414, -0.136, 0.148 and 0.323 for the row, 114, 97, 57 and 35 for the
column, and 0.084 and 0.362 for the tendon force, still far below the ceiling of 1.2.

It does what follows. Build a `StandRig` per setting with `reflex: { ...DEFAULT_REFLEX, ... }`, run `episode` over
several seeds, and read `aliveSeconds`. For a trained body, `MlpPolicy.fit` the checkpoint against
`rig.inputNames` and `rig.outputNames` first. The flags do the same for a real run: `--reflex`,
`--reflex-velocity`, `--reflex-setpoint`, `--reflex-inhibition`, `--reflex-ceiling`,
`--reflex-force-inhibition`, `--reflex-delay`.

## Making them trainable

`SpinalModule.gains` has a setter and `StandRig` exposes its cord, so the seven numbers could be
appended to the search vector and set per candidate. Nothing is stopping it but the decision: it
adds seven dimensions to a search over 27142 and changes what a checkpoint means, since the cord
would then be part of what was learnt rather than part of the body it was learnt in.
