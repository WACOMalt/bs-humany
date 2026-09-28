/**
 * The Align tab's host: the reference models beside ours, and the points of ours that need
 * moving.
 *
 * The panel (`align/alignPanel.ts`) is built once and given the scene, because it draws into the
 * same world the body is in. Its reference data is fetched rather than bundled, so a studio nobody
 * aligns anything in never pays for it. What it needs of the studio -- our compiled body, the
 * drawn skeleton's tints, the camera's hold on the pointer, the run paused at rest, the file
 * helpers -- it asks for through the host made here.
 */

import type { Simulation } from '@bs-humany/session';
import {
  type AlignHost,
  type AlignPanel,
  createAlignPanel,
  loadSourceSites,
} from './align/alignPanel.js';
import { attachmentSites, jointsOnSegment } from './align/ourBody.js';
import type { StudioRuns } from './runController.js';
import type { StudioScene } from './scene.js';
import { download, openTextFile, usesNativeFilePickers } from './session.js';
import type { BodyPanel } from './ui/bodyPanel.js';
import { must } from './ui/dom.js';
import type { StatusLine } from './ui/transport.js';

/**
 * What the studio offers the Align tab beyond what its `AlignHost` declares today: hooks the
 * panel's next change reads, provided here because they reach into the run, the frame loop and
 * the file helpers, which the panel cannot get at.
 */
export interface AlignHostHooks {
  /** Our compiled muscle set, for the panel to read attachment and via sites from itself. */
  muscles(): Simulation['muscles'];
  /**
   * Hold the body at rest while the Align points are shown, or let it go.
   *
   * Points are defined and recorded at rest, so a point is only judged fairly against the bone it
   * sits on when that bone is at rest too. Holding pauses a live run -- never discarding it -- and
   * draws the skeleton at rest with the pose overlays hidden. Letting go draws the run's paused
   * pose again and does not resume it: nobody asked for it to move.
   */
  holdRest(on: boolean): void;
  /** Write a file through the studio's saving helper; true once it is written. */
  save(name: string, text: string): Promise<boolean>;
  /** The body a saved alignment was made against: the running one's profile and morphology. */
  body(): { profile: string; morphology: Simulation['recording']['morphology'] } | undefined;
  /** Ask for a JSON file to load, however this studio asks; its text, or undefined if none. */
  open(): Promise<string | undefined>;
}

export interface AlignStudioHost {
  readonly runs: StudioRuns;
  readonly scene: StudioScene;
  readonly body: BodyPanel;
  readonly status: StatusLine;
  /** Write a file and say what happened. */
  saving(what: string, write: Promise<boolean>): Promise<boolean>;
}

export interface StudioAlign {
  readonly panel: AlignPanel;
  /**
   * True while the Align tab asks for the body at rest, because the points it shows are defined
   * and recorded at rest and are judged against the bone they sit on.
   */
  holdsRest(): boolean;
  /**
   * Whether the Align tab's gizmo claims the pointer, so the camera holds still for it.
   *
   * The dragging flag alone is not enough to claim the press that *starts* a drag: three sets its
   * own `dragging` inside its pointerdown handler, which runs after the orbit controls have
   * already been offered the same press. So the claim asks the panel whether the pointer is over a
   * handle, which is known from hover, and the flag only keeps the camera still for the rest of
   * the drag.
   */
  claimsPointer(): boolean;
}

export function createAlign(host: AlignStudioHost): StudioAlign {
  const { runs, status } = host;
  /** True while the Align tab's gizmo is being dragged. */
  let gizmoDragging = false;
  let alignHoldsRest = false;
  /**
   * The browser picker still waiting for its answer, if any: a way to settle it with nothing.
   * See `openAlignFile`.
   */
  let abandonAlignPick: (() => void) | null = null;

  /**
   * Ask for a JSON file for the Align tab: the desktop shell's dialog, or the page's hidden input.
   *
   * Resolves undefined when the dialog is dismissed. Not every browser reports a dismissed
   * picker, so an ask that is never answered is settled with undefined by the next one instead,
   * rather than left listening on the input and handed the next file as well.
   */
  const openAlignFile = (): Promise<string | undefined> => {
    if (usesNativeFilePickers()) return openTextFile();
    const input = must<HTMLInputElement>('#align-load-file');
    abandonAlignPick?.();
    return new Promise((resolve, reject) => {
      const settle = () => {
        input.removeEventListener('change', picked);
        input.removeEventListener('cancel', dismissed);
        abandonAlignPick = null;
      };
      const dismissed = () => {
        settle();
        resolve(undefined);
      };
      const picked = () => {
        settle();
        const file = input.files?.[0];
        input.value = '';
        if (file) file.text().then(resolve, reject);
        else resolve(undefined);
      };
      abandonAlignPick = dismissed;
      input.addEventListener('change', picked);
      input.addEventListener('cancel', dismissed);
      input.click();
    });
  };

  const alignHost: AlignHost & AlignHostHooks = {
    articulation: () => runs.simulation?.articulation,
    units: () => runs.simulation?.muscles?.units.map((u) => u.id) ?? [],
    muscles: () => runs.simulation?.muscles,
    // Our joints and attachments at rest are pure functions of the compiled body, in
    // `align/ourBody.ts` where they are tested. The joints used to be worked out here, and the
    // sites too -- looked up as though every bone were a segment, which dropped the 288 of 544
    // sites whose bone is not one, the femur's and the humerus's among them.
    jointsOn: (segment) => {
      const sim = runs.simulation;
      if (!sim) return [];
      // The hinge axes the panel's shape still carries are read by nothing any more (settling a
      // bone's roll by them measured worse than inheriting it; see `fit.ts`), so none are given.
      return jointsOnSegment(sim.articulation, segment).map((joint) => ({ ...joint, axes: [] }));
    },
    sites: () => {
      const sim = runs.simulation;
      return sim ? attachmentSites(sim.articulation, sim.muscles) : [];
    },
    /**
     * Light up one of our segments, or clear it with undefined.
     *
     * All the bones the segment owns -- a segment is several bones, and `thigh_r` has to light up
     * as a femur rather than as a dot at an origin -- tinted on the drawn mesh, under the
     * inspector's own tint.
     */
    highlightSegment: (id) => {
      const segment = id
        ? runs.simulation?.articulation.segments.find((s) => s.id === id)
        : undefined;
      host.body.setAlignedSegment(segment ? segment.bones : []);
    },
    save: (name, text) => host.saving(name, download(name, text, 'application/json')),
    setGizmoDragging: (dragging) => {
      gizmoDragging = dragging;
    },
    holdRest: (on) => {
      if (on === alignHoldsRest) return;
      alignHoldsRest = on;
      const sim = runs.simulation;
      if (on && sim && !sim.paused) {
        runs.pause();
        status.announce('Paused: the Align points are drawn at rest.');
      }
      // The frame loop draws the change, and hides or shows the overlays with it.
    },
    body: () => {
      const sim = runs.simulation;
      return sim
        ? { profile: sim.recording.profile, morphology: sim.recording.morphology }
        : undefined;
    },
    open: openAlignFile,
  };

  const panel = createAlignPanel(alignHost, host.scene.camera, host.scene.renderer);
  panel.attach(host.scene.world);
  void loadSourceSites().then((data) => {
    if (data) panel.adopt(data);
  });

  return {
    panel,
    holdsRest: () => alignHoldsRest,
    claimsPointer: () => gizmoDragging || panel.overGizmo(),
  };
}
