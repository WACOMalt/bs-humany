# What the cord's gains are worth, measured

The spinal module has seven numbers and not one of them is trained. Evolution Strategies searches
the policy's weights -- 27142 of them for a 742 x 32 x 32 x 70 network -- and the cord is part of
the body those weights are searched against, fixed for the whole run by the recipe or the
`--reflex*` flags and saved with the checkpoint so the studio can set itself up the same way.

So they are chosen by measurement, and this is the measurement.

## The stretch reflex, on the body as it stands

Eight seeds of the reference stand, six-second episodes, the policy silent so that what is being
measured is the cord and nothing else, with the tremor and sense grain training itself uses.

| stretch | velocity damper | seconds upright | fitness |
|---|---|---|---|
| 0 | 0 | 0.48 | 1.070 |
| 0.001 | 1 | **0.52** | **1.153** |
| 0.002 | 1 | 0.49 | 1.092 |
| 0.003 | 1 | 0.47 | 1.040 |
| 0.005 | 1 | 0.43 | 0.941 |
| 0.005 | 0 | 0.43 | 0.938 |
| 0.008 | 1 | 0.39 | 0.833 |
| 0.012 | 1 | 0.35 | 0.742 |

Above about a thousandth the reflex costs the body time on its feet, monotonically, and by 0.012 it
has taken a quarter of it. The best row is 0.001 and it is four hundredths of a second better than
no cord at all across eight seeds, which is not a difference worth claiming.

**This is a change.** `DEFAULT_REFLEX.stretch` is 0.005 because when it was chosen the same
measurement ran 0.33 s with no cord, 0.67 s at 0.005, and 0.87 s with the velocity damper on top.
Every one of those numbers is now wrong: the body stands half a second on its own where it used to
manage a third, and the cord subtracts from that instead of adding. What changed in between is the
body -- every spinal joint moved to its disc and now leans with the spine, and the hand and the
toes gained 38 muscles. A gain tuned against the old geometry is not tuned against this one.

What the table does **not** measure is what the cord is for. A silent body falling over is one
signal; the reflex is meant to be a floor under a policy that is still learning, and the argument
that first put it at 0.005 was that 0.8 saturated 94 per cent of the muscles and left a trained
policy at 0.016 against 1.006 with the reflexes off -- a cord that silences the policy is worse
than no cord. That much stands. Where between 0 and 0.005 a *training run* does best is a question
this table cannot answer, and the way to answer it is two runs.

## Reproducing it

Build a `StandRig` per setting with `reflex: { ...DEFAULT_REFLEX, stretch, velocity }`, run
`episode` with zero weights over several seeds, and read `aliveSeconds`. The flags do the same for
a real run: `--reflex`, `--reflex-velocity`, `--reflex-setpoint`, `--reflex-inhibition`,
`--reflex-ceiling`, `--reflex-force-inhibition`, `--reflex-delay`.

## Making them trainable

`SpinalModule.gains` has a setter and `StandRig` exposes its cord, so the seven numbers could be
appended to the search vector and set per candidate. Nothing is stopping it but the decision: it
adds seven dimensions to a search over 27142 and changes what a checkpoint means, since the cord
would then be part of what was learnt rather than part of the body it was learnt in.
