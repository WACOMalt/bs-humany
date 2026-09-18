# A native OpenXR viewer

The first thing here that is not a web view. What it is for, right now, is deciding whether the
native route is worth taking before weeks go into it.

## The three steps, in the order they stop being checkable from a terminal

```bash
cargo run --release -- check-pack     # needs no hardware at all
cargo run --release -- probe          # needs a runtime, not a headset
cargo run --release -- session 10     # needs a headset
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

Drawing is deliberately not here yet. Two hundred rigid meshes is not the risky part.

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

This crate is step one of that: prove the runtime, the pack and the frame budget. The bridge and
the pipeline come after, in that order.
