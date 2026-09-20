# The headset as the studio: VR parity

What has to happen for the OpenXR viewer to show everything the desktop studio shows and to
offer the same panels, one to one, plus what only the headset needs. A checklist, in the order
it is being done, so it can be picked up mid-way. `docs/plans/studio-ui-redesign.md` is the
desktop side this follows.

## Where things stand

The viewer draws bones, muscle tubes, controllers, a grid and the scenario's boxes, and one
fixed panel with five tabs (Run, Scenario, Body, Muscles, Rates). It does not draw joints,
discs, cartilage or any overlay, does not tint muscles by tension, cannot be moved, has no
Brain, and knows nothing of training. The studio publishes poses, muscle rings and a status
JSON; the status carries the settings, the drive groups and the diagnostics, and no more.

## 1. Bridge protocol -- the studio publishes what the headset needs

- [x] `VrStatus` gains `mode`, `overlays`, `scenarioParameters`, `muscleReadout`, `tension`,
      `tissue` (discs and bars in bone frames) and `brain` (`apps/studio/src/vrLink.ts`).
- [x] `VrCommand` gains `brain` actions: select, handover, release, authority, trainStart,
      trainStop, follow.
- [x] The brain panel exposes `state()` and `act()` for the headset (`apps/studio/src/brain.ts`).
- [ ] `vrHost.status` in `apps/studio/src/main.ts` fills the new fields; `vrHost.command`
      handles `set overlay.<name>`, `set scenario.<param>`, `set percentile`, `set grid`, and
      the `brain` kind. Status stays at 10 Hz; `tissue` is static per run but small, so it
      rides along.
- [ ] `tools/cli/bin/publish-pose.mjs` publishes the same keys it can (mode, overlays,
      scenarioParameters, muscleReadout, tension; no brain), so a headless publisher's panel
      is not a different panel.
- [ ] The showcase's `training` and `tension` keys are read by the viewer too.

## 2. The viewer reads it (`apps/xr-viewer/src/bridge.rs`)

- [ ] `Status` gains the fields above, all `#[serde(default)]`, plus `training` from the
      showcase.
- [ ] `Command::Brain { action, id, value }` and its JSON.

## 3. The viewer draws it (`apps/xr-viewer/src/render.rs`, `xr.rs`, shaders)

- [ ] Vertex format gains a tint float (pos, normal, slot, tint): 0 draws the slot's colour,
      otherwise the slack-to-taut ramp the studio uses; muscle tubes carry the unit's tension.
- [ ] A tissue buffer, rebuilt each frame from the bone matrices and the status's tissue
      table: a disc (16-sided cylinder) or a bead (sphere) per held joint in its parent bone's
      frame, a bar per weld between its two bones' points. Its own slot and colour (the
      studio's pale teal / cartilage orange). Off when the `tissue` overlay is off.
- [ ] Overlays honoured: muscle tubes off when `muscles`/`muscleVolumes` are off; grid follows
      `grid`.
- [ ] Two panels: `draw` takes a slice of `PanelDraw`.

## 4. The panels (`apps/xr-viewer/src/panel.rs`, `xr.rs`)

- [ ] **Properties panel**, floating, tabs down its left edge like the desktop's: Body, World,
      Sim, Scene, Muscles, Brain, Export, Health -- the same controls, the same ids sent as
      `set` keys, the same live-during-drag behaviour. Export shows what cannot be done from a
      headset (file dialogs) as disabled with a line saying so.
- [ ] **Transport panel**, one horizontal strip: Start/Resume, Pause, Reset, the mode, Play,
      frame back, frame on, Live, the playhead, the time, grid and turntable-equivalents that
      make sense in VR (grid only), and the overlay toggles.
- [ ] **Grab strip** on the left edge of each panel: point at it, hold the trigger, and the
      panel follows the hand (its placement is re-derived from the controller pose with the
      offset it had when grabbed; released, it stays). Both panels remember their placement
      for the session.
- [ ] **Brain tab**: the checkpoint list, Hand over, Release, Authority, the fit line, the
      activity note, Start/Stop training, Follow bridge, the training line -- each sending the
      `brain` command the studio acts on; the activity bitmap itself is desktop-only for now.

## 5. Desktop

- [x] `Connect VR viewer` still unhides under Tauri in the new top bar (`main.ts:2059`).
- [ ] `pnpm desktop:appimage` builds with the new sidecar; the AppImage launches, connects the
      viewer, and the viewer shows the new muscles and tissue. (First build started on the
      pre-parity code to validate packaging.)
- [ ] `apps/studio/src-tauri/README.md` version table says 0.2.0.

## 6. Verify

- [ ] `cargo build --release` for the viewer; `pnpm publish:pose` headless and the viewer's
      panels against it; the studio's Connect VR on the desktop build.
- [ ] Tests: brain `state()`/`act()`; the tissue table in status; the command handler's new
      keys. Rust: `cargo test` for the panel's command JSON.
- [ ] `apps/xr-viewer/README.md` describes the two panels, the grab strip, the Brain tab.
