# Exporting a simulation to Blender

The studio exports a run as an animated glTF binary (`.glb`) in which **every simulation tick
is a keyframe at its exact time**. Nothing is resampled: a 500 Hz run gives 500 keyframes per
second, a 1000 Hz run 1000.

## How to use it

1. Run a simulation in the studio. Every tick is captured from the moment the run starts (or
   from the last rewind, restore or morphology change).
2. Press **Export for Blender (.glb)**, then **Import script (.py)**. Save both files next to
   each other.
3. In Blender, open the Scripting workspace, load the `.py` and run it (or run
   `blender --python <file>.py` from a shell). The script sets the scene frame rate to the
   simulation rate, imports the `.glb`, and sets the frame range to the capture.

Importing the `.glb` directly also works, but into a 24 fps scene the keyframes land on
fractional frames; the script exists so each tick is an integer frame.

## What the file contains

- **Hierarchy.** One node per bone (206), nested by anatomical parent, sacrum at the root.
  Node names are the bone ids (`femur_r`); the display name, TA code, region and owning
  segment are in each node's `extras`.
- **Meshes.** Each bone's measured mesh, at the stature of the run, in the bone's own frame.
  The pack in memory at export time is used: the full pack on a desktop, the quarter-size level
  of detail on a phone.
- **Animation.** Translation and rotation channels for every node, keyed at
  `tick / rate` seconds, linear interpolation, parent-relative so the hierarchy carries the
  motion. Consecutive rotations are kept on the same quaternion hemisphere.
- **Frame.** The canonical frame of the project: +X right, +Y up, +Z posterior, metres.
  glTF is Y-up, so no conversion is applied on export; Blender converts to its Z-up on import.
- **Provenance.** `scene.extras` records the rate, frame count, first captured tick, profile,
  backend, scenario, morphology, and the CC BY-SA attribution of the mesh data, which the
  export carries with it.

## Limits

- The capture holds up to 256 MB (about 90 s at 500 Hz for 206 bones). When the budget is
  reached the studio says so, keeps the earlier frames, and the export marks `captureFull`.
- A rewind on the timeline truncates the capture to that tick; stepping forward again
  overwrites. A session restore or morphology change starts a new capture.
- Bones are rigid objects, not an armature: for visual validation that is the direct
  representation. Retargeting onto a rigged character would need a skin, which is not exported.
