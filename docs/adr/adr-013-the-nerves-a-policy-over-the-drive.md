# ADR-013 — The nerves: a policy over the drive, trained on the simulation itself

**Status:** accepted, 2026-09-19. **Depends on:** ADR-004 (accumulators), M-ADR-003 (excitation,
not activation), the activation clips (`docs/sources/humansim-activation-research.md`).

## The question

The body has muscles, a drive that sets their excitation, clips that play a pattern into that
drive, and sliders. What it lacks is anything that reads the body and answers: a quietly standing
body goes over in under a second because nothing notices it leaning. The next layer is the one
that notices. What shape should it have, what should it read and write, and how should it learn?

## The decision

**A `NervesModule` in the `control` phase, adding onto `efferent.alphaMotor`.** It reads the
channels that already exist -- joint angles and rates, the pelvis's pose and velocity, the feet's
contacts, every muscle's activation and fibre length -- and a goal vector saying what is wanted.
It writes by *adding* signed corrections to the excitation accumulator, which is clamped
downstream. So whatever a clip or a slider has already put there stays: the clip is the
feedforward, the pattern of the behaviour; the nerves are the feedback that keeps it on its
feet. That is how a spinal cord and a pattern generator divide the work, and it is also what
makes the module safe to add to a scenario that already runs: with a zero policy it changes
nothing.

**Groups, not units.** Forty-six outputs, twenty-three drive groups a side, each spread evenly
over its units. The hundred and forty-eight units are the wrong dimension to control or to train
in; the groups are the dimension a person reasons in and the sliders already use.

**A small network, run inside the tick.** A two-hidden-layer perceptron of a few tens of
thousands of weights, evaluated every fifth tick -- a hundred hertz against forty-millisecond
deactivation is plenty -- and its command held between evaluations but added every tick,
because the accumulator is zeroed every tick. It runs in a web view and in a headset's publisher
without noticing.

**Trained by evolution strategies, on this simulation, in worker threads.** OpenAI-ES with
mirrored sampling, rank-shaped fitness and Adam. No gradient is needed through the simulation --
there is none to be had through a WebAssembly solver -- and every episode is independent, so a
generation is a set of episodes spread over as many cores as the machine has. The fitness is
standing: a point a hundredth of a second the head is up, a little for a level and still pelvis,
a little off for effort, and a random twitch each episode so what is learned is standing through
a nudge. The trained weights are a JSON file the scenario imports.

**Not in Python, not in native MuJoCo.** A native MuJoCo would run the rollouts a hundred times
faster and could not run *these* muscles: the path solver, the wrapping, the Hill model and the
via points are this repository's and not MuJoCo's, and a policy trained against different
muscles would be trained for a different body. The simulation is the thing being controlled, so
the simulation is what it is trained on. If rollout cost ever binds, the answer is a faster
kernel, not a different model.

**Seen, always.** A controller nobody can see is a controller nobody can judge. The policy keeps
every layer's activations from its last evaluation, and they are drawn: in the studio as a
bitmap in the panel, on the training dashboard alongside the live body and the drives, and on
the panel in the headset when it gets there.

**No golden for a policy-driven scenario.** Its policy file changes with every training run; a
hash of its trajectory would be a record of the last run, not of the physics. `golden: false`
keeps it out of the gate, and the physics it runs on is the physics the other scenarios pin.

## What it does not decide

Which behaviours beyond standing, how the goal vector grows, whether the observation gains a
head-mounted vestibular sense or an efference copy, and when evolution strategies stop being
enough and a gradient method on a learned model takes over. Each is a training run away, and
none changes the module's contract.
