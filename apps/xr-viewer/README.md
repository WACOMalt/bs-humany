# The headset viewer

A native OpenXR/Vulkan viewer, and the studio's headset renderer. It ships as the desktop studio's
sidecar: **Connect VR viewer** launches it on the studio's own run, or, from a terminal, it
follows `pnpm publish:pose`. It draws the body from the mesh pack, the muscles as tubes tinted by
their tension and the connective tissue, all posed from the simulation; it puts the studio's
controls in the room on two panels that drive the run exactly as the mouse does; and the
controllers grab bones, press and carry the panels, and walk, turn and lift you about the body.

It began as a probe for whether the native route was worth taking at all. What that found is kept
below as history, under "What it answered".

## From the studio

The desktop studio has a **Connect VR viewer** button beside the export buttons. It launches this
viewer on the studio's own run: the headset shows the body on screen, the controllers grab it,
and the panels drive the studio's controls -- the same sliders and buttons the mouse uses, so the
two never disagree about what the run is doing. Disconnect stops the viewer.

The studio is the publisher then, not `pnpm publish:pose`. Its page builds the bridge bytes with
the same codec and hands them to the Tauri side in one batch a frame, which writes them in place
on tmpfs; the grab channel and the panel's command log come back the same way. The viewer is
the one named by `BS_HUMANY_XR_VIEWER` if that is set; otherwise the copy beside the studio's
executable, which is where a release ships it; otherwise, running from a checkout, this crate's
`target/release`. A debug build of the studio takes the checkout's build over the copy beside it
when the checkout's is newer, so a viewer rebuilt with cargo is the one Connect launches. The
mesh pack is found by `BS_HUMANY_PACK_DIR`, the studio's bundled resources, or the checkout.

### Moving about

The left thumbstick walks you through the world at up to two metres a second, in the direction
you are looking, flattened to the floor. The right one turns and lifts: left and right turn you
about where your head is, a little over a right angle a second, and forward and back raise and
lower you at a little over a metre a second -- which is how you get above the body to look down
at it, or under the floor.

A stick whose controller is aimed at a panel's face scrolls that panel instead, and moves you not
at all: forward brings the top of a long tab into view, back its bottom. Aim away and the stick
walks, turns and lifts again.

Turning is smooth unless you ask otherwise. Tick **Snap turn** at the foot of the transport strip
and the right stick turns you in thirty-degree steps instead: one step as the stick is pushed
past seven tenths of the way over, and no other until it has come back inside three tenths, so a
stick held over turns you once. Rising and walking are the same either way. It is the headset's
own setting, the one box on the strip the publisher never hears of, so it works with no
publisher running and is never greyed with the rest of the strip when the publisher falls
silent. It lasts until the viewer stops.

Press either stick in to **recentre**: you are back where you started, the body and the scenery
in front of you as they were, and both panels come back to their places in front of wherever
you are standing and looking. A panel you were carrying is put down, and a bone you were holding
is let go, since the world has just jumped under the hand; keep squeezing and the hand takes
hold afresh. Getting lost -- walked off past the end of the grid, the panels behind you -- is
one press.

The headset says the same itself, as a two-column guide on the properties panel while it waits
for a publisher and at the foot of its Health tab once one is running, from one list
(`CONTROLS` in `src/panel.rs`, which a test holds this table to):

| Control                     | Does                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| Left stick                  | walk, the way you are looking                                    |
| Right stick                 | turn (left / right), rise or sink (forward / back)               |
| Grip on a bone              | grab it (the trigger, on a basic controller)                     |
| Trigger at a panel          | press                                                            |
| Stick, aimed at a panel     | scroll it                                                        |
| Trigger on the dotted strip | carry the panel                                                  |
| Stick click                 | recentre: back to the start, the panels in front of you          |
| Snap turn                   | a box on the transport strip: the right stick turns in 30° steps |

Each controller draws its aim ray: a thin blue line from the tip of the controller, down the way
it points, to the blue mark where it meets a panel, or a metre and a half into the room when it
meets none. A hand holding a bone draws none, since it is not a pointer then. The controllers also
tick as things happen, so the hand knows without looking: a short, light tick as a press lands on a
panel's face, and a longer, firmer one on grabbing a bone and letting it go, and on taking a panel
by its strip and putting it down.

What actually happens is the other way round: the world -- body, muscles, grid, scenery and
panel -- is moved and turned under a stage that never moves, and the hands, which belong to the
stage, are not; nor are the rays and the marks, which are the hands'. A grab or a press carries
the move and the turn back over, so nothing else knows you moved, and a recentre is that move
and turn set back to nothing.

### Which controllers

The viewer binds its actions for each controller below, and the runtime picks the binding for
the controller in your hand. The Index's is the one it was built against and must be accepted;
a runtime that refuses any other says so on the terminal and the viewer carries on without it.

| Controller                     | Grab           | Press   | Walk, turn, lift | Recentre         |
| ------------------------------ | -------------- | ------- | ---------------- | ---------------- |
| Valve Index                    | grip (squeeze) | trigger | thumbstick       | thumbstick click |
| Oculus / Meta Touch            | grip           | trigger | thumbstick       | thumbstick click |
| Windows Mixed Reality          | grip           | trigger | thumbstick       | thumbstick click |
| HP Reverb G2                   | grip           | trigger | thumbstick       | thumbstick click |
| HTC Vive wand                  | grip           | trigger | trackpad         | trackpad click   |
| Anything else (simple profile) | select         | select  | none             | none             |

The HP controller has a profile of its own behind an OpenXR extension, which the viewer asks for
only when the runtime offers it; without it, the runtime binds a Reverb through whichever of the
others it maps it to, as runtimes do for any controller an application has no binding of its own
for. On a Vive the trackpad is the stick: a thumb resting on it walks, so lift the thumb to stand
still, and pressing it in to recentre may move you a little on the way. The simple profile has
one button, which both grabs and presses, and no stick, so there is no walking, turning or
recentre on it.

Which profile the runtime settled on for each hand is said when it settles and whenever it
changes -- `hands: left uses valve/index_controller` on the terminal -- and under the controls
guide on the panel, which also says when a hand is on the simple profile and why its stick does
nothing.

### Grabbing it

The studio's Ctrl-click, in the headset: squeeze a controller on a bone and the bone comes with
the hand, on the same grab module and the same spring. The controllers are drawn as blue cubes at
their grip poses, and the grip is the grab: the squeeze sensor on an Index, the grip button on the
others (the one select button, on anything that only speaks the simple profile; see "Which
controllers").

This is the bridge running the other way. The viewer writes a slot per hand every frame beside
the pose ring -- `<pose path>-grab`, laid out in the same file as the pose format -- saying
whether the hand is squeezing, which bone it took, where it took it, and where the hand is now,
all in the simulation's own frame. The publisher reads both slots every tick and does exactly what
`beginGrab` does in the studio: finds the segment behind the bone, expresses the point in that
segment's frame, and holds it toward the hand. Letting go is one inactive slot, read once.
Each hand is its own grab slot, so both can hold at once, and the same bone with both if you like.

Which bone, and where on it, is judged in the room: bones are sieved by their posed extent, the
survivors have their vertices carried into the room, and the nearest vertex within five
centimetres of the hand is the point taken. From then on that point rides with the hand -- its
offset at the grab, turned by however much the hand has turned since -- and the hand's
orientation goes across too, so twisting the hand twists the bone: the MuJoCo backend holds a
grabbed segment with a rotational spring beside the point spring, sized as the same spring at a
hand's lever and leashed to a radian. Squeezing empty air grabs nothing and sends nothing.

A press does only what it began on. One begun in the air, on a bone, or with the hand holding a
bone presses nothing until the trigger is let go, however many buttons its ray then crosses, and
a hand holding a bone is not a pointer at all. Both because squeezing to grab tends to pull the
trigger, and a ray sweeping the panel with the trigger held was clicking whatever it crossed --
including the buttons that rebuild the run.

The scenery comes with the status: the ground's height, which lifts the body so it stands on
the grid whatever the scenario's floor is at, and every static box -- the stairs, the seat --
drawn in the simulation's frame.

The status lines say what is happening on both sides:

```
hand right: tracked
hand right: grabbed femur_r
  142.8 Hz, worst CPU frame 0.44 ms, pose 6 ms old, 861 muscle frames, holding femur_r
hand right: let go
```

and, in the publisher, `holding femur_r` on its own line while it lasts.

### The panels

The studio's controls, in the room, on two dark panels that face where you stand: the
**properties panel**, sixty centimetres wide, to your right of the body at chest height, and the
**transport strip** a metre wide under it. Point a controller at either and its ray runs to a
small blue mark where it lands; the trigger presses, with a tick.

Down the left edge of each is a **grab strip**, a darker band with a row of dots. Point at it,
pull the trigger, and the panel comes with the hand -- turned as the hand turns -- until the
trigger is let go, when it stays where it was put. The strip lights while the panel is carried,
and a press on it is a grab and never a click. Only a press that begins on the strip carries the
panel. Put the transport where your hand rests and the properties wherever you can read them.

A press on a panel's face keeps that panel until the trigger is let go, wherever the ray goes: off
an edge, the mark and the press stay on the face at the edge nearest the ray. So a slider dragged
past its end lands at its end, and a drag that slides onto the strip goes on dragging rather than
picking the panel up. If the ray is lost altogether the press ends there, and a slider sends the
value it had reached; the ray coming back with the trigger still down presses nothing.

Where the two panels overlap, the ray takes the nearer, and the nearer is drawn over the farther:
carry the transport in front of the properties panel and you are pointing at the transport.

The properties panel's tabs scroll when they are longer than the panel -- the Muscles tab is, with
its Spine at the foot, and longer again once its regions are opened -- with the stick of the hand aimed at them, or by the bar
down the column's right edge, which a ray can drag. Rows scrolled out of the column are cut at its
edges, and each tab keeps its own place.

The properties panel's tabs run down its left edge like the desktop's, Health under the same
Developer divider, and each is the desktop's tab, the same controls sending the same keys. The
desktop's other developer's tab, Align, opens and saves files and is not drawn here:

- **Body** -- skeletal proportions, stature, mass, the ANSUR percentile, which reads back where
  the body sits; what is held. The crural and brachial indices and relative leg length are not
  applied to the measured skeleton yet, which is one subject scaled by stature, so the desktop
  greys its sliders and the headset has none, only the note that says so. The bone inspector
  stays on the desktop.
- **World** -- gravity, floor; passive joint resistance, spinal redistribution; drop height;
  grab strength.
- **Sim** -- steps a second, output frames a second; the diagnostics readout, with the tick
  rate as the desktop words it (steps coming out against the step rate, and how fast against
  life). The capture budget is the desktop's.
- **Scene** -- a button per scenario and a slider per parameter the scenario has; muscles on or
  off; a button per fidelity profile, named as the desktop's picker names it ("L3 — Anatomical
  ...") and sending the profile's id.
- **Muscles** -- a drive slider per muscle group, folded by region as the desktop folds them:
  every group in `MUSCLE_GROUPS` (`packages/scenarios/src/muscleGroups.ts`: 35 today, in its
  five sections, Hand among them), the one table both sides draw from; the readout. The number
  beside a slider is the excitation it asks for, the square of its travel, as the desktop
  prints it (50 along reads 25%); what is sent is still the position, which the publisher
  squares, and a number typed into the box is read as that excitation. The readout is the
  desktop's: the pull of each body section -- arm, hand, leg, trunk, neck, every drive group in
  it summed over both sides -- then how many units are loaded, wrapping and out of range. Under
  them the Spine: the cord's stretch for all regions, then one stretch a region (arm, hand, leg,
  trunk, neck, each saying "as all" while it follows the first), damping, set point, reciprocal
  inhibition and conduction delay, and the desktop's line on the cord as it is set. With muscles off the drive and the
  readout go and the Spine stays, as its gains are the next run's.
- **Brain** -- the checkpoints the studio's Brain tab lists: the dashboard's while it runs,
  otherwise the ones this studio trained or shipped with. It ships one, `balance`, the default
  behaviour, trained in Drop, standing at 0 m -- the scenario the studio opens on -- and only far
  enough to save, so under it the body still falls. `pnpm publish:pose` sends no brain, so
  from it the list is empty. Choosing one only shows it, and the desktop's line under the list
  says how it was trained and what differs; Set up as trained puts that on the desktop's tabs,
  Authority included, and Undo set-up takes it back once. Neither asks anything on the desktop,
  where nobody in the headset could answer. Then the authority, Hand over (which sets up first
  when the tabs differ, restarting a run whose scene or body changes) and Release, the fit line;
  the activity bitmap stays on the desktop.
- **Training** -- the policy's memory; Start and Stop training, and Follow bridge, which reads
  Stop following once it is following, with the training line. Stop training stops the showcase
  that plays the run as well as the trainer, which is what the studio follows. The training's
  generations, population, episode length and workers are as set on the desktop.
- **Export** -- what cannot be done from a headset, disabled, with the line that says why.
- **Health** -- this run's profile, by name, and rates, the bridge's state, and the controls
  guide with the controllers the runtime says are in hand; the diagnostics are under Sim, and
  the compile report, the inertia audit and the joint sweep stay on the desktop.

Every slider but the drives and the timeline takes its bounds and its step from the status's
`controls`, which is `CONTROL_RANGES` in `packages/scenarios/src/controls.ts` -- the same table
the desktop's sliders are held to by a test -- and moves in those steps while it is dragged, so
what is let go of is what was shown and is what is sent. A slider whose key the publisher sends
no range for is not drawn: that publisher does not honour it. A scenario's own parameters carry
their bounds and step with them.

The transport strip is the desktop's top bar and timeline in one: Start or Resume, Pause,
Reset; the mode -- own run, paused, at rest, or following the bridge -- with the speed, and
"live" when the desktop's playhead is on the live edge; Play, a frame back, a frame on, Live,
and the playhead to scrub; then the overlays; then the headset's own Snap turn box, beside
what the hands are holding. The timeline is the desktop's: its handle sits
where the desktop's playhead is, scrubbed back or replaying, and runs to the end of the
recording. Play is the desktop's play and pause: it reads Pause while the desktop plays its
recording back, and each press sends the state it names -- `play` false to pause, true to
play -- rather than a bare toggle. The headless publisher has no recording;
there the timeline is the run's own time and Play resumes it. Grid, muscle volumes and
connective tissue are honoured here; muscle paths, proxies, axes, centres of mass and contacts
are the desktop viewport's, toggled from here all the same. The muscles are drawn here as their
volumes, so the Muscle volumes box alone shows or hides them.

What changes the articulation -- scenario, profile, muscles, the body, the rates -- rebuilds the
simulation on the publisher's side and the bridges reopen, and those sliders send only when let
go; the rest -- drives, the timeline, grab strength -- applies to the run as it goes and sends as
it is dragged. Export, save and load stay in the studio, since they open file dialogs.

### What is drawn

Bones, from the mesh pack, posed from the bridge. Muscles as tubes swept from the belly rings,
tinted from slack to taut by each unit's tendon force as the studio tints its own -- the status
carries the tension. The connective tissue as the studio's overlay draws it: a pale disc at
every held spinal level, a bead at each costovertebral hinge, a bar of cartilage between each rib
and the sternum, built each frame from the bone poses and the table of frames the status
carries, so a publisher that says nothing of tissue simply shows none. The overlays the studio's
viewport has turned off are off here too.

A grid on the floor, half-metre squares out to five metres, is the stage's own frame: where the
headset thinks the floor is, which is where the body stands.

The panels are drawn with egui -- immediate mode, laid out afresh each frame from what the
publisher last said -- on their own pipeline over the same render pass as the bones, so the body
occludes them and they occlude the body like anything else in the room. The web UI itself
cannot come along: there is no way to get a WebKit view onto a Vulkan image at headset rate, and
the controls that matter from inside a headset are few enough to draw again.

egui draws at two pixels a point, so its font atlas holds each glyph at twice the size a point
would need; read from arm's length or further, the panel covers fewer of the headset's pixels
than that. Each of egui's textures is therefore built with a full mip chain, blitted level by
level on the GPU after every upload, and sampled trilinearly, so small text is averaged rather
than shimmering as the head moves. A device that cannot blit and linearly filter
`R8G8B8A8_SRGB` gets the single level it had before. Labels are a light grey and notes a darker
one that still clears WCAG's 4.5:1 over the panel's fill, whatever is behind it.

Two files beside the pose ring carry it. The publisher rewrites `<path>-status.json` ten times a
second (every 100 ms) -- a temporary file renamed into place, so it is never half-written -- and the
viewer appends commands to `<path>-commands.jsonl`, one JSON object a line, which the publisher
reads from wherever it last stopped. Switching scenario rebuilds the simulation and every bridge
file on the publisher's side and bumps a generation in the status; the viewer sees it change and
reopens everything, which is a stall of a frame or two.

## Running it by hand

```bash
cargo run --release -- check-pack     # needs no hardware at all
cargo run --release -- probe          # needs a runtime, not a headset
cargo run --release -- session 10     # needs a headset
cargo run --release -- view 30        # needs a headset, and draws
cargo run --release -- view --follow  # ...posed live by a running simulation, until Ctrl-C
```

In the order they stop being checkable from a terminal.

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

**`view`** is the one that draws: the body standing a metre and a half away, both eyes in one
multiview pass, for as many seconds as you ask. It reports the frame rate it held and the worst
CPU frame at the end.

It reports the rate it is holding every couple of seconds rather than only at the end, because
the natural way to stop watching something in a headset is to take it off and press Ctrl-C, and a
summary that only prints on a clean exit is a summary nobody sees.

Its loop has the shape ADR-012 requires: it takes the head pose the runtime predicts for this
frame and draws from the pose buffer as it stands, never waiting for anything upstream. A slow
simulation is a slow body in a view that is still tracked at the headset's rate, rather than a
headset stalling on a slow tick.

### Following a live simulation

Two terminals. The simulation, headless, publishing a pose every output frame:

```bash
pnpm publish:pose                                   # default scenario, L1, 144 poses a second
pnpm publish:pose tilting-floor --profile l3_anatomical --fps 90
```

And the viewer, reading them:

```bash
cargo run --release -- view --follow
```

It runs until Ctrl-C, or until the runtime ends the session; a number of seconds after `view`
stops it sooner.

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

What crosses the bridge is bones: 206 of them, seven floats each, plus the rest pose and the stature
scale once. The muscles cross beside them as rings rather than meshes -- one belly per muscle unit
(`ALL_MUSCLE_UNITS` in `packages/muscle-data/src/wholeBody.ts`), `DEFAULT_RINGS` (24) rings each,
eight floats a ring: centre, orientation, radius -- and the viewer sweeps its own tubes from them
each time a new frame arrives, on the same pipeline as the bones with a second draw. That is units ×
24 × 32 bytes a frame, about 209 KB with the full 272, against about 1.9 MB for the positions and
normals of the twelve vertices round each ring they sweep into; and the sweep is a few microseconds.
A publisher with muscles off writes no muscle file, and the viewer says so and draws bones alone.

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

Run on the machine under "What it answered" below, it put the skeleton in the headset at a good
rate, which is the answer that mattered. But "it looked right" is not a regression test, so the
matrix maths is also checked against this headset's own reported numbers -- `cargo test`, five of
them:

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
SHADERC_LIB_DIR=/usr/lib64 cargo run --example compile-shaders --features compile-shaders
```

An example rather than a binary, with `shaderc` behind the `compile-shaders` feature, so
`cargo test` needs no shader toolchain. Same bargain as the generated
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

## What it answered, on the machine it was written for (history)

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
