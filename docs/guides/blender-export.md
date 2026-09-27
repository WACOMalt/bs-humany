# Exporting a simulation to Blender

The studio exports a run as three files that belong together: an animated glTF binary (`.glb`)
with the bones, a PC2 vertex cache (`.pc2`) with the muscle bellies' movement, and a Python
script (`.py`) that imports the two into a scene set up for them. Every bone keyframe sits at its
exact simulated time, and a second of simulated time is a second of Blender timeline.

## How to use it

1. Run a simulation in the studio. Everything is captured from the moment the run starts, or
   from the last Reset, session load or body change.
2. Open the **Export** tab and press **Export for Blender**. It greys out and the status bar says
   *Exporting for Blender…* while the files are built, which takes a few seconds on a long run;
   when they are written it says how many, how large and how long the build took.
   - In a browser that is three downloads. In the desktop app it is one folder dialog, and all
     three are written into the folder you choose.
   - The `.pc2` is written only when the run had muscles. Without them there are two files.
   - The files are named `bs-humany-<scenario>-<profile>-<rate>hz-<fps>fps`, with `.glb`, `.pc2`
     and `.py` after it: for example `bs-humany-quiet-standing-l3_anatomical-1000hz-60fps.py`.
3. Keep the three files together in one folder. The script looks for the `.glb` beside itself,
   and for the `.pc2` beside the `.glb`.
4. In Blender, open the Scripting workspace, load the `.py` and run it, or run
   `blender --python <file>.py` from a shell. The script sets the scene's frame rate and frame
   range, imports the `.glb`, and attaches the `.pc2` to the muscles.

If the script cannot find the `.glb`, it says so and names where it looked: beside itself, beside
the `.blend`, and in the working directory. Put the full path in the `GLB` line at the top of the
script and run it again. If the `.pc2` is missing, the import still finishes and prints that the
bellies will not move.

Importing the `.glb` on its own also works, but three things go wrong. The bellies do not move,
because their movement is in the `.pc2`. Into a 24 fps scene the keyframes land on fractional
frames. And Blender draws each of the hundred-odd joint empties one metre across, which buries the
skeleton in a thicket of axes. The script sets the frame rate, shrinks the empties to a
centimetre, and puts the joint centres in their own hidden collection. Un-hide **Joint centres**
in the outliner when you want to inspect a pivot.

## Timing

Two rates are set on the **Sim** tab, and keeping them apart is the point.

- **The scene's frame rate is the output frame rate**, not the step rate. The step rate says how
  finely a second was computed; the output rate says how finely the Blender timeline is divided.
- **Bone keyframes sit at their exact simulated time**, `tick / rate` seconds, linear
  interpolation. Nothing is resampled: 1000 steps a second into a 60 fps scene puts about
  seventeen keyframes inside each frame, all real. Every step is kept, unless one output frame
  would hold more than 50 of them (`MAX_SAMPLES_PER_FRAME`). Then every Nth step is kept, the
  smallest N that leaves no more than 50 in a frame, and the times do not move. For example,
  1000 Hz into 12 fps is 83 steps a frame, so every 2nd step is kept. The stride is recorded in
  `scene.extras` and in the script's header.
- **The muscle cache is one sample per output frame**, because a Mesh Cache modifier plays
  frames and a cache finer than the frames it is played at is bytes nobody reads. Each sample is
  the bellies as they were on that frame's tick.

## What the files contain

- **Bones.** One node per bone (206), nested by anatomical parent, each carrying its measured
  mesh at the stature of the run in the bone's own frame. Node names are the bone ids
  (`femur_r`); the display name, TA code, region and owning segment are in each node's `extras`.
  The pack in memory at export time is used: the full pack on a desktop, the quarter-size level of
  detail on a phone. Translation and rotation channels are parent-relative, so the hierarchy
  carries the motion, and consecutive rotations are kept on the same quaternion hemisphere.
- **Joint centres.** A `joint__<id>` node at every pivot, parented to the bone the pivot is fixed
  in, so it travels with the body. Each carries its DoF axes, ranges and neutral angles in
  `extras`. Where the joint has an intervertebral disc or a costovertebral bead, that is the
  node's mesh. Select one and look at the bone around it to check a pivot by eye: a hip centre
  belongs in the middle of the femoral head, not on its surface.
- **Costal cartilage.** A root named `tissue` holds one `cartilage__<weld>` bar per costal weld,
  each a skinned mesh with one end bound to each of the two bones it joins.
- **Muscles.** A root named `muscles` holds one mesh with every belly in it, at its first captured
  frame. It has no keyframes and no skin: the `.pc2` moves it, through a Mesh Cache modifier the
  script adds. The script also gives each muscle a vertex group named by its unit id, so one can
  be selected or masked, and a flesh material.
- **Scene geometry.** A root named `scene` holds the ground (a 20 m square at the ground height
  of the run) and every static box of the scenario, such as the stairs and the landing, as
  unanimated nodes at their world placement.
- **Frame.** The canonical frame of the project: +X right, +Y up, +Z posterior, metres. glTF is
  Y-up, so no conversion is applied to the `.glb`; Blender converts to its Z-up on import. The
  `.pc2` does not pass through the importer, so it is written already in Blender's axes.
- **Provenance.** `scene.extras` records `rateHz`, `outputFramerate`, `seconds`, `frames` (the
  keyframes written), `stride`, `recordedSteps` (the steps captured, before the stride),
  `firstTick`, `captureFull`, the profile, backend, scenario and morphology, `muscles` (the number
  of muscle units in the mesh), a `hierarchy` sentence describing all of the above, and the
  CC BY-SA attribution of the mesh data, which the export carries with it.

## Limits

- **The capture budget** is the **Capture budget** slider in the **Recording** panel of the
  **Sim** tab. It runs from 32 MB up to this tab's JavaScript heap limit, and opens at a fifth of
  that limit, because writing the files needs about five copies of the capture in memory at once.
  It applies to each capture separately: one for the bones, one for the muscle cross-sections.
- **The bone capture and the muscle capture stop together** when either fills. With the muscles
  running, the muscle capture is the one that fills first. The status line under the slider says
  which one stopped and when; the frames already held are kept, and they still export, with
  `captureFull` set. To capture more, raise the budget, then Reset and Start: the run is
  deterministic and replays the same unless you grabbed, dragged or changed a drive or gravity
  during it.
- **Keep the budget inside the tab's heap.** A browser tab does not get the machine's memory, and
  a capture that runs past the heap does not stop politely: the tab dies and takes the run with
  it. Above the default is yours to judge.
- A rewind on the timeline shows what was captured without changing it. Reset, a session load or
  a body change starts a new capture.
- Bones are rigid objects, not an armature: for visual validation that is the direct
  representation. Retargeting onto a rigged character would need a skin, which is not exported.
