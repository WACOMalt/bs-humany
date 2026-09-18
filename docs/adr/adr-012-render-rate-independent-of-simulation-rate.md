# ADR-012 — The render rate is independent of the simulation rate

**Status:** Accepted

## Decision

A renderer draws at the display's rate using the most recent body pose it has, and never waits for
a newer one. Head tracking is sampled per rendered frame; body state is whatever the simulation
last published. The two rates are unrelated, and a renderer that has outrun the simulation redraws
the pose it already holds rather than stalling.

The handoff is therefore **latest-wins and non-blocking in both directions**: the simulation never
waits for a renderer to collect a frame, and a renderer never waits for the simulation to produce
one. No queue, no backpressure, no dropped-frame accounting — a pose that is superseded before
anybody drew it is simply overwritten.

## Rationale

These are two different questions wearing one word, and the studio's frame loop currently answers
them together: it advances the simulation by one output frame per rendered frame, so the two rates
are locked and the slower one sets both.

In a headset that is not merely suboptimal, it is the wrong shape. What has to happen at the
display's rate is the **view** — the projection from the tracked head pose. What may happen at any
rate at all is the **body**. A head that turns and sees the scene lag is a comfort failure and,
past a few milliseconds, a nausea one; a body that moves in slow motion is a simulation that is
slow, which is a fact about the simulation and looks exactly like what it is.

Measured on the machine this was written for: the headset runs at 142.7 Hz, a frame every 7 ms.
L1 with the full muscle set computes at 1.28 times real time and can feed that. L3 computes at
0.39 and cannot. Locking the rates together would make L3 unusable in a headset. Separating them
makes L3 a comfortable, fully tracked view of a body moving at two fifths speed — which for
inspecting a simulation is not a degradation but the normal way to look at one.

It also removes a class of failure entirely. With the rates locked, a simulation that stalls takes
the view with it, which in a headset is the thing that must never happen. Decoupled, a stalled
simulation is a still body in a scene the viewer can still walk around.

## Consequences

- The transport between a simulation and a renderer is a small ring of buffers with an atomic
  "newest complete" index, not a channel with a queue. The kernel's existing double-buffered
  transport is already this shape; a third buffer lets a writer work while a reader holds one.
- A renderer must be able to say how stale its pose is, because "the body is not moving" and "the
  simulation died" look identical otherwise.
- Interpolating between the last two published poses is permitted and is a renderer's own
  business. It is not required, and it must never be achieved by holding a frame back to have
  something to interpolate towards — that trades the thing this ADR is protecting for smoothness
  nobody asked for.
- This does not apply to the studio's own canvas loop, where one output frame per rendered frame
  is deliberate and gives a reproducible run (see the frame-loop notes in `apps/studio`). It
  applies wherever a renderer is downstream of a simulation it does not own.

## What would need to change for this to be revisited

A use where the body's motion must be locked to the display — a rhythm task, or anything where the
simulation is driven by what the viewer does inside the frame. That is a control loop rather than a
viewer, and it would need its own answer rather than a change to this one.
