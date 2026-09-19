# The studio, rethought as a studio

A plan for turning the studio's one long side panel into an application shaped like the tools
people already know -- Blender is the reference, at a fraction of its scope -- with the
controls sorted by what they are *for* rather than by the order they were written in, and a
brain panel that puts a trained policy in charge of the body and starts a training run from the
same place.

## 1. What the controls are, at the concept level

Every control the studio has today, grouped by the concept it serves. The ids are the ones in
`index.html` and stay, so the wiring in `main.ts` keeps working while the page around it changes.

### The body -- what is being simulated
| Concept | Controls today | Notes |
|---|---|---|
| Who the body is | `sex`, `stature`, `mass`, `percentile`, `crural`, `brachial`, `legLength` | Rebuilds the mesh; a run survives with its state carried. |
| How finely the body is articulated | `profile` (L0 to L3), `backend` | Needs a new run. |
| The bone under the cursor | `#inspector` (click a bone) | Read-only. |

### The world -- what the body is in
| Concept | Controls today | Notes |
|---|---|---|
| Forces on it | `gravity`, `floor` | Live mid-run. |
| Tissues that are not muscle | `passive` (joint resistance), `redistribute` (spinal shares) | Need a new run. The discs and cartilage of OQ-029 and OQ-011 have no switch; they are part of the skeleton. |
| The hand of the user | `grabStrength`, Ctrl-drag in the viewport | Live. |
| Where it starts | `dropHeight` (free drop only) | Needs a new run. |

### The simulation -- how it is computed
| Concept | Controls today | Notes |
|---|---|---|
| Time resolution | `stepsPerSecond` | Fixed for a run; profile sets a default. |
| Output resolution | `outputFramerate` | Live; also the export's keyframe rate. |
| Memory for the recording | `captureBudget` | Live. |
| Run state | `simStart`, `simPause`, `reset`, `#sim-status` | The transport. |

### The scenario -- what happens
| Concept | Controls today | Notes |
|---|---|---|
| Which scenario | `scenario`, `#scenario-note`, generated `scenario-<param>` sliders | Needs a new run. |
| Whether muscles run | `muscles` | A scenario may force it on. |

### The muscles -- what drives the body by hand
| Concept | Controls today | Notes |
|---|---|---|
| Drive per group | 29 generated sliders in `#muscle-drives`, one `<details>` per section (Arm, Leg, Trunk, Neck) | Live; squared mapping. |
| What the muscles are doing | `#muscle-readout` (elbow, knee, loaded, wrapping, out of range) | Read-only, every frame. |

### The brain -- what drives the body by itself
| Concept | Controls today | Notes |
|---|---|---|
| The policy in the loop | none: a scenario carries its policy file, `#nerves-control` appears by itself | Only `nerves-stand` puts one in. |
| Its activity | `#nerves-activity` canvas, `#nerves-note` | Read-only. |
| Watching a training run | `follow-bridge` (Follow the bridge) | Needs `pnpm train:dashboard`. |
| Starting one | none: a terminal | `pnpm train:nerves`, `pnpm train:showcase`. |

### Time -- where in the run we are looking
| Concept | Controls today | Notes |
|---|---|---|
| Scrub, step, replay | `timeline`, `playToggle`, `frameBack`, `frameForward`, `goLive`, `#playback-note` | Live only when the playhead is at the newest frame. |

### The view -- how it is drawn
| Concept | Controls today | Notes |
|---|---|---|
| Camera | View buttons (front, left, back, three-quarter), orbit, pan, zoom, `spin` | Camera only. |
| Mesh detail | `quality` (tessellation) | Rebuilds the mesh. |
| What else is drawn | `showGrid`; overlays `showProxies`, `showAxes`, `showCom`, `showContacts`, `showTissue`, `showMuscles`, `showMuscleVolumes` | Live. |
| How much the page explains | `showNotes` | CSS only. |

### Files -- what comes in and goes out
| Concept | Controls today | Notes |
|---|---|---|
| The recording | `export` (JSON), `export-blender` (glTF + point cache + script), `#capture-status` | Need a run. |
| The session | `save`, `load` (+ hidden `load-file`) | Settings and, when running, the whole kernel state. |
| The headset | `connect-vr` | Desktop only. |

### Health -- whether the numbers are right
| Concept | Controls today | Notes |
|---|---|---|
| The run's ledger | `#diagnostics` (kinetic, potential, drift, limits, contacts, rate, cost) | Every frame. |
| The compile | `#sim-report`, `#capabilities` | Once a run. |
| The body's arithmetic | `#inertia-audit`, `#joint-sweep` | On rebuild. |
| The page's cost | `#stat-*` | Every frame. |
| What is known to be wrong | `#limitations` | Static. |

## 2. What Blender gets right that this page does not

- **Editors, not a scroll.** Blender is a set of editors -- a 3D viewport, a properties editor,
  a timeline, an outliner -- each with its own header and its own job. The page today is one
  scroll of everything, so the timeline is between the muscle sliders and the overlays, and the
  transport is a third of the way down.
- **Properties are tabbed by what they describe.** Scene, world, object, physics: the same
  object seen from different concerns, one concern at a time, with a vertical strip of tabs to
  switch. That is exactly the grouping in section 1.
- **The transport lives in the timeline**, at the bottom, always in reach, with the frame
  counter beside it.
- **Overlays and shading are the viewport's own**, in its header, not in a settings list.
- **A status bar** says what the app is doing and what the mouse can do here.
- **Everything has a default view and remembers what you changed**: Blender keeps the layout;
  this page forgets every toggle on reload.

## 3. The layout

```
+---------------------------------------------------------------------------------------+
| bs-humany  |  L3 Anatomical v  |  MuJoCo  |  > Start  || Pause  |<> Reset  |  Live    |  VR  |
+-----------------------------------------------------------------+---------------------+
| viewport header: Front Left Back 3/4 | Tessellation v | Overlays v | Grid | Turntable |  B  |
|                                                                 |  o  | Body          |
|                                                                 |  d  |               |
|                        3D viewport                              |  y  |  Properties   |
|                                                                 |     |  of the       |
|                                                                 |  W  |  active tab   |
|                                                                 |  o  |               |
|                                                                 |  r  |               |
|                                                                 |  l  |               |
|                                                                 |  d  |               |
|                                                                 | ... |               |
+-----------------------------------------------------------------+     |               |
| timeline: |> Play  <| |>  Live   [========o=============]  f 240 / 900   4.00 s      |
+-----------------------------------------------------------------+---------------------+
| status: Running, 4.0 s simulated, at 0.9x life speed.   drag to orbit · Ctrl-drag to pull |
+---------------------------------------------------------------------------------------+
```

Four regions on a CSS grid, the viewport taking whatever is left:

- **Top bar.** Identity, the scene's fidelity profile and backend, the transport
  (Start / Pause / Reset), the live-or-following indicator, VR connect on the desktop, and
  session save/load under a file menu.
- **Viewport** with its own header: view presets, tessellation, an Overlays popover holding
  every overlay checkbox, grid and turntable. The canvas is the whole region; the hint moves to
  the status bar.
- **Properties editor** on the right: a vertical strip of icon tabs and one tab's panel, each
  panel a stack of collapsible sections. The tabs are the concepts of section 1:

  | Tab | Sections |
  |---|---|
  | Body | Who (proportions, ANSUR), Articulation (profile, backend), Inspector |
  | World | Forces, Tissues, Start pose, The hand |
  | Simulation | Time (steps per second, output frame rate), Recording (capture budget), Status |
  | Scenario | Scenario and its parameters, Muscles on/off |
  | Muscles | Drive by group (Arm, Leg, Trunk, Neck), Readout |
  | Brain | Policy in the loop, Activity, Training |
  | Export | Recording, Blender, Session |
  | Health | Ledger, Compile report, Inertia audit, Joint sweep, Cost, Limitations |

- **Timeline** along the bottom of the viewport: transport for the recording (play, step,
  live), the scrubber, frame and time readouts, and the recording's size.
- **Status bar** across the whole width: the simulation status on the left, the viewport hint
  on the right.

The narrow-screen rule stays: below 760 px the properties editor becomes a bottom sheet and the
timeline sits above it.

## 4. The brain panel

The one panel that is new rather than rearranged.

**Policy in the loop.**
- A list of saved checkpoints, fetched from the dashboard server's new `GET /policies`: every
  `packages/modules-nerves/policies/*.json`, and every `tools/train/runs/*-latest.json`'s
  record and `*-centre.json` (the search's live centre). Each row: name, task, profile it was
  trained on, generations, fitness, when. The list refreshes while training runs.
- **Hand over control**: loads the chosen policy into the running body. A policy is fitted to
  the body by the names of its senses and drives (`MlpPolicy.fit`), so any checkpoint fits any
  profile; the row says how much of it carried. The nerves module is registered at construction,
  so handing over is a restart with the state carried -- the same path a morphology change
  takes -- with `nerves` set on the simulation's options rather than only on the scenario's.
- **Authority** slider (0 to 1): how much a policy may add or take from any group.
- **Release**: restart without the policy, state carried.
- The activity bitmap and the note move here from `#nerves-control`.

**Training.**
- Fields: task (stand), generations, population, workers, seconds per episode, seeds,
  authority, resume from the search's centre.
- **Start training** posts them to `POST /train/start` on the dashboard server, which spawns
  `train-nerves.mjs` and `showcase.mjs` as it would from the terminal, and the studio switches
  to *Follow the bridge* so the viewport shows the learner. **Stop training** posts
  `/train/stop`; `GET /train/status` reports whether a run is up, its generation, mean, top
  and record from `*-latest.json`, drawn as a small chart in the panel.
- The server binds `127.0.0.1` only, spawns nothing but those two scripts with validated
  numeric arguments, and refuses a second run while one is up. The studio in a browser can
  only start what the machine's own dashboard server offers; on the desktop the same route is
  used, so there is one path.

## 5. Components

New files, each small and testable where it can be:

| File | Job |
|---|---|
| `apps/studio/src/ui/tabs.ts` | Vertical tab strip ↔ panel switching, remembers the active tab. |
| `apps/studio/src/ui/popover.ts` | The viewport's Overlays popover. |
| `apps/studio/src/ui/memory.ts` | Persists layout choices (active tab, overlays, notes, grid, turntable, collapsed sections) in `localStorage`, tolerant of it being absent. |
| `apps/studio/src/brain.ts` | The brain panel: checkpoint list, hand-over, authority, training start/stop/status against the dashboard server. |
| `apps/studio/src/style.css` | Rewritten around the grid: top bar, viewport header, properties editor, timeline, status bar, tokens kept. |
| `apps/studio/index.html` | Rewritten around the layout; every control id kept. |
| `tools/train/bin/dashboard.mjs` | `GET /policies`, `POST /train/start`, `POST /train/stop`, `GET /train/status`. |
| `apps/studio/src/simulation.ts` | `nerves` as a simulation option, independent of the scenario. |
| `apps/studio/src/main.ts` | Rewire: status bar, timeline region, brain panel, overlays popover, `showTissue` listener (missing today). |

Changed but kept: `playback.ts`, `follow.ts`, `vrLink.ts`, `session.ts` (session gains the
layout memory's keys? no -- layout is the page's, not the run's).

## 6. Steps

1. **Plan** -- this document. ☑
2. ☑ **Skeleton of the layout.** New `index.html` with the five regions and the tab strip;
   every existing control moved under its concept, ids intact; new `style.css` on a grid; the
   viewport header and the Overlays popover; the status bar carrying `#sim-status` and the hint;
   the timeline region. `main.ts` still finds every id. Verify: the page loads, a run starts,
   every control still acts, the narrow layout still works.
3. ☑ **Tabs and memory.** `tabs.ts`, `memory.ts`; the active tab, the overlays, grid, turntable,
   notes and collapsed sections survive a reload.
4. ☑ **Brain: hand over.** `nerves` as a `SimulationOptions` field; the brain panel's checkpoint
   list from `GET /policies`; hand over and release with state carried; the authority slider;
   activity bitmap and note in the panel; the fit report ("476 of 500 senses carried").
5. ☑ **Brain: training.** The dashboard server's `/train/*` routes; start, stop, status; the
   studio follows the bridge on start and shows the run's curve.
6. ☑ **Polish.** Keyboard: Space play/pause, Left/Right frame step, Home live, 1/3/7 views as in
   Blender's numpad. Tooltips on every tab. The `showTissue` listener. Explanatory text as a
   toggle in the status bar.
7. ☑ **Verify and document.** Browser pass on every tab at L3, desktop build, README's studio
   section, this plan's checkboxes ticked.

## 7. What does not change

The simulation, the bridge, the VR panel and the headless publisher are untouched: the VR panel
drives the same DOM ids through `setFromPanel`, and it keeps doing so. Session files keep their
format. Every test that exists keeps passing; the tabs and the memory get tests of their own.
