# ADR-014 — A spinal cord under the brain, and a search that needs no terminal

**Status:** accepted, 2026-09-21; amended 2026-09-22 (the gains, remeasured; see the
[amendment](#amended-2026-09-22--the-gains-remeasured)). **Depends on:** ADR-013 (the nerves),
§14.1 (the nervous system module), §10.5 (delay lines), ADR-004 (accumulators). **Related:**
OQ-024 (standing is a reflex, `docs/sources/open-questions.md`).

## The question

ADR-013 put a trained policy over the drive and left four things open: which behaviours beyond
standing, how the goal vector grows, whether the observation gains a head-mounted vestibular
sense or an efference copy, and when evolution strategies stop being enough.

After nine hundred and twenty-five generations on the tilting floor the body stayed up for 1.2
seconds. The best run anywhere, quiet standing at four hundred and fifteen generations, managed
2.53 of a six-second episode. That is not a search converging slowly; it is a search with almost
no signal. Why, and what is missing?

## What was actually wrong

Four things, and only one of them was the search.

**There was no spinal layer at all.** Section 14.1 calls the spinal loops "the natural first
target"; nothing implemented them, and every mention of "reflex" in the repository was prose in
a comment. Standing is mostly not a learned skill. A real body is held up by intrinsic muscle
stiffness and a loop through the cord that never reaches the brain, and what the brain adds is
slow and sits on top of a body already roughly upright. Without that layer the search had to
discover the whole stabilising feedback law from scratch.

**The senses it would need were published and unread.** `muscle.state` carries `fiberVelocity`
and `tendonForce`; the observation took only activation and fibre length. So the controller had
the spindle's group II and no group Ia — no damping term, the one a feedback law cannot do
without — and no Golgi Ib at all, which is to say no sense of bearing weight. The balance task
scores the head while the senses described the pelvis.

**The policy had no state.** A feed-forward network answers the instant it is shown and nothing
else: it cannot tell a body leaning from one that has leant and come back, cannot average a
noisy sense over time, and cannot predict. Adding grain to the senses without adding memory was
a tax, because integrating a noisy sense is the whole answer to it.

**Every candidate died at the same moment.** The episode ended on the first step the head left
its band, so a generation's scores differed by a few hundredths of a second and the rank
transform was ranking noise.

## The decision

**A `SpinalModule` in the `control` phase, before the nerves.** The monosynaptic stretch reflex
per unit, reciprocal inhibition through an antagonist table that lives beside the group table,
and autogenic inhibition from the Golgi organ. It adds onto `efferent.alphaMotor` like every
other driver, so zero gains change nothing.

**Every afferent goes through a `DelayLine`.** Built and tested in Phase 1 per §10.5 and used by
nothing until now. The cord answers the body as it was thirty milliseconds ago, which is the
only regime a real one works in, and the regime a policy trained above it had better learn in.

**The three afferents §14.1 names, and the vestibular pair.** Fibre velocity as Ia, tendon force
as Ib, and the head's own down and spin so the controller can feel the quantity it is graded on.
Appended by name, so every existing checkpoint still fits and the new senses start from nothing.

**Memory as context units, not a new kind of network.** Extra named inputs the policy reads and
extra named outputs it writes, fed back from its own last answer. `MlpPolicy` stays a plain
perceptron; the loop is closed in the module. Because they are named like any other sense, a
checkpoint crosses a change of memory the way it already crossed a change of body, and a policy
file declares its own memory in its drive names so a handover cannot silently drop it.

**Fitness gains the centre of mass over the base of support, and the head may leave its band for
a quarter second.** A stumble that recovers is the behaviour worth rewarding and it could not be
rewarded once the episode was already over.

*(Superseded — this paragraph and the next: see the
[amendment](#amended-2026-09-22--the-gains-remeasured). Its principle, in bold at the end, stands.)*

**The gains are measured, not chosen.** This is the part that nearly went wrong. Fibre stretch
is counted in whole optimal lengths, so the first defaults — a gain near one — drove every
muscle to the excitation ceiling within a tick. The body became a rigid statue, survived
slightly longer, and was useless: the brain above adds its correction to an excitation already
clamped at 1 and the clamp eats it. A trained comparison put it at 0.016 against 1.006 with the
reflexes off. **A cord that silences the policy is worse than no cord.**

Measured on the reference body with no policy at all (`tools/train/runs/cordlevel.mjs`,
`cordsweep.mjs`): a slack body keeps its head in band for 0.33 s; stretch at 0.005 gets 0.67 s at
about five percent excitation with nothing saturated; the damper at 1 gets 0.87 s. Reciprocal
inhibition has a sharp optimum — 0.3 gives 0.76 s where none gives 0.35 and all of it gives 0.11.

**The search runs wherever it is asked to.** The loop moved out of the command-line trainer into
`tools/train/src/trainer.ts` with nothing of Node in it; a pool scores candidates and a store
keeps three named things, and both are interfaces. The rig was already portable — a compiler, a
kernel and a MuJoCo built to WebAssembly — so the same class that scores episodes in a worker
thread scores them in a window. Training now happens inside the studio binary, which already
carried the bridges and launched the headset's viewer. The dashboard became a convenience.

## What it does not decide

Whether the cord should be tuned per profile rather than once on the reference body. Whether the
set point should be something the brain writes rather than a constant — which is what a gamma
motor neuron is, and the honest next step. Whether evolution strategies survive the larger
policy that memory implies. And whether a body that now stays up for 0.87 seconds on reflexes
alone can be trained to stand, which is a run, not a decision. (The 0.87 s is superseded: the
amendment below gives what the cord is worth now.)

## Amended 2026-09-22 — the gains, remeasured

Recorded 2026-09-26. The decision above stands: a spinal module in the control phase, every
afferent through a delay line, the vestibular pair, context units, the fitness change and a
search that runs anywhere. What changed is every number in "The gains are measured, not chosen",
and the reason given there for keeping the gains tiny. The text above is kept as it was written.
The current measurements and the tables behind them are in
[`docs/validation/reflex-gains.md`](../validation/reflex-gains.md).

**Why the old numbers are void.** Two commits took them away. First, 79da900 repeated the
measurement after every spinal joint had moved to its disc and the hands and toes had gained 38
muscles, and found that the body had changed under it: with no policy, stretch at 0.005 now cost
time (0.43 s against 0.48 s with no cord). Then ba50a95 found the real fault. `muscle.state`
already publishes fibre length in optimal fibre lengths, and the cord divided it by the optimal
fibre length in metres a second time. The length afferent therefore ran from 2.3 to 41 where the
strain runs from -0.44 to 0, and it read every muscle as hugely stretched at every instant,
standing still included. That was a constant tone, not a stretch reflex, and it is the whole
explanation of the tiny gains: 0.005 was as much as could be applied before the tone saturated
the body. So the "whole optimal lengths" rationale, the 0.33, 0.67 and 0.87 s, the 0.016 against
1.006, and the "sharp optimum" of reciprocal inhibition were all measured against that tone, and
none of them describes the cord that runs today. Remeasured, time upright rises monotonically
with inhibition past every value that means anything, so this measure cannot choose inhibition at
all.

**What is set now.** The length afferent is `fiberLength - 1` against a set point of 0, so the
cord is quiet until a fibre is actually stretched. `DEFAULT_REFLEX` (`tools/train/src/recipe.ts`)
is:

| stretch | velocity | setPoint | inhibition | forceCeiling | forceInhibition | delaySeconds |
|---|---|---|---|---|---|---|
| 3.5 | 0.25 | 0 | 0.3 | 1.2 | 0.5 | 0.03 |

Stretch and velocity are measured. The set point is where the cord stops answering a body that
stands still. Inhibition stays at 0.3, unchanged and unclaimed, because choosing it needs two
training runs, not a table. The Golgi ceiling is never reached in a fall, so the two force terms
are left where they were, and nothing has shown them right. Under the committed standing policy,
over eight seeds of six seconds, this cord keeps the body upright 0.894 s against 0.456 s with no
cord at all. With the policy silent it is 0.568 s against 0.484 s. The cord is a floor, not a
controller.

**What still holds.** A cord that silences the policy is worse than no cord. Past a stretch of 4
the time upright falls again, because the brain adds its correction to an excitation the cord has
already clamped at 1, and the clamp eats it. The principle was right; only the scale it was
measured at was wrong.

**Where the evidence lives.** `tools/train/runs/cordlevel.mjs` and `cordsweep.mjs`, which the
superseded paragraph cites, were local probes in an ignored directory. They were never committed,
and they measured the afferent before the fix, at settings nothing uses now. They are superseded,
not promoted. The section "Reproducing all of it" in reflex-gains.md says how to produce the
current numbers from `StandRig` and `DEFAULT_REFLEX`.

Run files are no longer kept in the repository. A run's recipe, its history, its centre and the
showcase's activity file are written to `<data>/runs`, and checkpoints to `<data>/policies`, where
`<data>` is the operating system's data directory (`~/.local/share/bs-humany` on Linux).
`pnpm train:where` prints both, and `BS_HUMANY_HOME` overrides them.
`packages/modules-nerves/policies` holds only the checkpoints that ship, which seed a fresh data
directory once. Handing a checkpoint to the studio is live: `Simulation.handOver` adopts the
policy between one control step and the next, and nothing restarts. A checkpoint's recipe records
the cord it was trained over, because that cord is part of the body the policy learnt in; a
recipe that records none was trained with none.
