# A native OpenXR viewer

The first thing here that is not a web view. What it is for, right now, is deciding whether the
native route is worth taking before weeks go into it.

## The three steps, in the order they stop being checkable from a terminal

```bash
cargo run --release -- check-pack     # needs no hardware at all
cargo run --release -- probe          # needs a runtime, not a headset
cargo run --release -- session 10     # needs a headset
cargo run --release -- view 30       # needs a headset, and draws
cargo run --release -- view 60 --follow   # ...posed live by a running simulation
```

**`check-pack`** loads `manifest.json` and `skeleton.bin` and says what came out. It is the half
of this crate that can be checked with nothing plugged in, and on this repository it should say:

```
bones     200  vertices 256030  triangles 511713
bounds    x -0.335..0.335   y 0.000..1.696   z -0.137..0.113
normals   255992 non-zero, worst length error 1.79e-7, mean (0.000, -0.012, 0.011)
```

A 1.7 m body standing with its feet at zero. The mean normal near zero is the check worth having:
a closed surface faces every way at once, so anything else means the winding or the accumulation
is wrong.

**`probe`** asks the loader which runtime answers, then asks the runtime for a headset, the view
configuration and the Vulkan version it will accept. It stops cleanly and says so if there is no
headset, because "no display attached" and "the runtime is broken" are different problems.

**`session`** begins a session and runs the frame loop for a few seconds, reading the predicted
display time and the eye poses, and **submits no layers** — which `xrEndFrame` permits. That is
the point of it: it exercises frame timing, the session state machine and head tracking without a
single line of rendering, so if it holds the headset's rate then everything left is ordinary
Vulkan rather than an unknown.

**`view`** is the one that draws: the skeleton standing a metre and a half away, both eyes in one
multiview pass, for as many seconds as you ask. It reports the frame rate it held and the worst
CPU frame at the end.

It reports the rate it is holding every couple of seconds rather than only at the end, because
the natural way to stop watching something in a headset is to take it off and press Ctrl-C, and a
summary that only prints on a clean exit is a summary nobody sees.

Its loop already has the shape ADR-012 requires -- it takes the head pose the runtime predicts for
this frame and draws from the pose buffer as it stands, never waiting for anything upstream. With
a rest pose that is invisible; it is the shape the loop has to have before a simulation is
attached, and retrofitting it afterwards is how a headset ends up stalling on a slow tick.

## What it answered, on the machine it was written for

    runtime   SteamVR/OpenXR 2.17.10, lighthouse tracking
    gpu       NVIDIA GeForce RTX 3090, queue family 0
    views     2016 x 2240 per eye, 1 sample, OPAQUE
    vulkan    1.0 to 1.2 -- the ceiling, so nothing 1.3-only
    session   IDLE -> READY -> SYNCHRONIZED -> VISIBLE -> FOCUSED
    rate      1428 frames over 10.00 s of predicted display time -- 142.7 Hz

Which is to say: every step of the native path works, and the budget is **7 ms a frame** for
9.03 megapixels of stereo. On a 3090, half a million triangles in one multiview pass is not close
to that, so the renderer is not where the difficulty is.

The eye poses came back 65.6 mm apart, which is an interpupillary distance rather than a number
somebody made up, so tracking and the stage space are both real.

**The consequence is for the simulation, not the renderer -- and it is smaller than it first
looks.** A 144 Hz headset wants a fresh *view* every 7 ms. It does not want a fresh *body* every
7 ms, and conflating those two is how a slow simulation would wrongly be made to look like a
broken headset.

The view is the projection from the tracked head pose, and it is drawn every frame regardless. The
body is whatever the simulation last published. So L1, which computes at 1.28 times real time,
gives a body moving at life speed; L3, which computes at 0.39, gives a body moving at two fifths
speed inside a view that is still perfectly tracked and perfectly comfortable. That is a slow
simulation, which is what it is, rather than an unusable one.

ADR-012 is where this is written down, along with what it means for the transport: latest-wins,
non-blocking in both directions, no queue.

## Following a live simulation

Two terminals. The simulation, headless, publishing a pose every output frame:

```bash
pnpm publish:pose                                   # default scenario, L1, 144 poses a second
pnpm publish:pose quiet-standing --profile l3_anatomical --fps 90
```

And the viewer, reading them:

```bash
cargo run --release -- view 120 --follow
```

The two never wait for each other, which is ADR-012 and is what `packages/pose-bridge` exists to
make true: the simulation writes the newest pose into a small ring on tmpfs and the viewer reads
whichever slot is newest each frame. A simulation that cannot keep up -- L3 with muscles, today --
publishes in slow motion and the headset shows a slow body in a perfectly tracked room. One that
has stopped shows a still body, and the viewer's status line says how old the pose is, because
"not moving" and "died" would otherwise look identical:

```
  142.9 Hz, worst CPU frame 0.41 ms, pose 7 ms old
```

Measured with the publisher on L1 with the full muscle set: `1.00x life` -- it keeps up exactly,
which is the 35 per cent the belly-sweep divisor bought.

What crosses the bridge is bones: 206 of them, seven floats each, plus the rest pose and the
stature scale once. The muscles cross beside them as rings rather than meshes -- 148 bellies of
24 rings, eight floats a ring: centre, orientation, radius -- and the viewer sweeps its own tubes
from them each time a new frame arrives, on the same pipeline as the bones with a second draw.
That is 113 KB a frame against the 1.4 MB the vertices would be, and the sweep is a few
microseconds. A publisher with muscles off writes no muscle file, and the viewer says so and
draws bones alone.

### Grabbing it

The studio's Ctrl-click, in the headset: squeeze a controller on a bone and the bone comes with
the hand, on the same grab module and the same spring. The controllers are drawn as blue cubes at
their grip poses, and the grip sensor is the grab on an Index controller (the trigger, on anything
that only speaks the simple profile).

This is the bridge running the other way. The viewer writes a slot per hand every frame beside
the pose ring -- `<pose path>-grab`, laid out in the same file as the pose format -- saying
whether the hand is squeezing, which bone it took, where it took it, and where the hand is now,
all in the simulation's own frame. The publisher reads both slots every tick and does exactly what
`beginGrab` does in the studio: finds the segment behind the bone, expresses the point in that
segment's frame, and holds it toward the hand. Letting go is one inactive slot, read once.
Each hand is its own grab slot, so both can hold at once, and the same bone with both if you like.

Which bone is judged in the room, not the simulation: each bone's posed centroid and half its
bounding diagonal, with a controller's width of reach on top, and the nearest surface among the
bones the hand is inside wins. Squeezing empty air grabs nothing and sends nothing.

The status lines say what is happening on both sides:

```
hand right: tracked
hand right: grabbed femur_r
  142.8 Hz, worst CPU frame 0.44 ms, pose 6 ms old, 861 muscle frames, holding femur_r
hand right: let go
```

and, in the publisher, `holding femur_r` on its own line while it lasts.

### The panel

The studio's controls, in the room: a dark panel half a metre wide, to your right of the body at
chest height, turned to face where you stand. Point a controller at it and a small blue mark
shows where the aim ray lands; the trigger presses. It shows which scenario is running, how far
along and how fast, what is held, and offers Pause and Resume, Reset, a grab-strength slider and
a button per scenario.

It is drawn with egui -- immediate mode, laid out afresh each frame from what the publisher last
said -- on its own pipeline over the same render pass as the bones, so the body occludes it and
it occludes the body like anything else in the room. The web UI itself cannot come along: there
is no way to get a WebKit view onto a Vulkan image at headset rate, and the controls that matter
from inside a headset are few enough to draw again.

Two files beside the pose ring carry it. The publisher rewrites `<path>-status.json` four times a
second -- a temporary file renamed into place, so it is never half-written -- and the viewer
appends commands to `<path>-commands.jsonl`, one JSON object a line, which the publisher reads
from wherever it last stopped. Switching scenario rebuilds the simulation and every bridge file
on the publisher's side and bumps a generation in the status; the viewer sees it change and
reopens everything, which is a stall of a frame or two.

## Choosing a runtime

The loader reads `~/.config/openxr/1/active_runtime.json`, and on this machine that currently
points at Monado while SteamVR is also installed. Monado needs its service running:

```bash
monado-service
```

To use SteamVR instead, point the active runtime at its manifest:

```bash
mkdir -p ~/.config/openxr/1 && ln -sf ~/.local/share/Steam/steamapps/common/SteamVR/steamxr_linux64.json ~/.config/openxr/1/active_runtime.json
```

`probe` will tell you which one answered.

## What the drawing was checked against

Run on the machine above it put the skeleton in the headset at a good rate, which is the answer
that mattered. But "it looked right" is not a regression test, so the matrix maths is also checked
against this headset's own reported numbers -- `cargo test`, five of them:

- near maps to 0 and far to 1, Vulkan's way, which is what the pipeline's LESS compare assumes;
- each edge of the reported fov lands on exactly the corresponding edge of clip space, which is
  what distinguishes a frustum built from four half-angles from one built from a single field of
  view;
- straight ahead is *not* at the centre, because this lens sees 1.00 rad to its left and 0.81 to
  its right and the view axis genuinely is off-centre;
- the view matrix puts the eye's own position at the origin and a point in front of a turned head
  a metre down -Z;
- and the half-turn that faces the body at the viewer has determinant +1 rather than -1 -- a
  mirror would also point the front the right way, and would swap an anatomical model's left and
  right, which is the kind of wrong that gets published before anybody notices.

## The shaders

GLSL in `shaders/`, compiled to the `.spv` beside it and committed, which the viewer embeds with
`include_bytes!`. An ordinary build therefore needs no shader toolchain. To change a shader:

```bash
SHADERC_LIB_DIR=/usr/lib64 cargo run --example compile-shaders
```

An example rather than a binary so `shaderc` stays a dev-dependency. Same bargain as the generated
data elsewhere in the repository: a generator, its output committed, and the two expected to agree.

## Why ash and not wgpu

OpenXR does not let an application choose its own Vulkan instance, physical device or device
extensions: it names them, and a session created against anything else fails with
`ERROR_GRAPHICS_DEVICE_INVALID`. `ash` obeys that literally. wgpu can be made to, through
`wgpu-hal`, but the interop is the part that breaks between versions and it buys nothing here —
the scene is small enough that the API is not what decides the frame rate.

The device is created with `VK_KHR_multiview` requested, because one pass for both eyes is the
saving that actually matters in stereo, and it has to be asked for at device creation.

## Why the loader is dlopened rather than linked

`features = ["loaded"]`. Linking wants `libopenxr_loader.so`, which lives in a development package
somebody running the binary has no reason to have installed; `libopenxr_loader.so.1`, which
`dlopen` finds, ships with every runtime. It also means a machine with no runtime gets a sentence
explaining that, rather than a binary that could not be built.

## Where this sits in the plan

The goal is the renderer native and the simulation where it is: TypeScript stays authoritative
and streams its render channels to a native process. The channels are already the right shape for
that — `body.pose`, `muscle.polyline`, `RENDER_MUSCLE_MESH` and the rest are SoA typed arrays with
a double-buffered transport built for the worker boundary, and M-ADR-004 already forbids Tier V
from writing anything else, so a second renderer is additive by construction.

This crate was step one of that -- prove the runtime, the pack and the frame budget -- and is now
the renderer end of the bridge as well. `src/bridge.rs` reads the ring; `fixtures/pose-bridge.bin`
is written by the TypeScript side and read by a test here, which is how two implementations of
one binary layout in two languages are kept honest with each other.
