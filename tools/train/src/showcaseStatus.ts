/**
 * What the training showcase says about the run it is playing, in the panel's status file.
 *
 * Here rather than in `bin/showcase.mjs`, so that it is typechecked: the status is a
 * `PanelStatus`, the contract the studio's link and `pnpm publish:pose` write too, and a field
 * the contract gains or renames fails to compile here instead of going missing from the headset
 * whenever it follows a showcase. The script loads this through the jiti it loads the rig with.
 *
 * A showcase has no panel of its own to offer: the policy under training is the thing, so there
 * are no scenarios to pick, no settings, no drive sliders. What it does say is which run and
 * generation is on screen, the scenery the body stands on and the tissue and tension to draw.
 */

import type { StaticBox } from '@bs-humany/compiler';
import {
  type PanelStatus,
  type PanelTissue,
  type PanelTraining,
  staticBoxJson,
} from '@bs-humany/pose-bridge/codec';

/** What the status is built from. */
export interface ShowcaseRun {
  /** Which run of the bridge files, as the viewer is told. */
  readonly generation: number;
  /** The recipe's name, which is the checkpoint's and names the scenario line. */
  readonly name: string;
  readonly profile: string;
  /** How long the body has been up this episode: the time the panel shows. */
  readonly upFor: number;
  readonly wallSeconds: number;
  readonly stepsPerSecond: number;
  readonly fps: number;
  readonly training: PanelTraining;
  readonly groundHeight: number;
  /** The scenario's scenery, where the solver has it this tick. */
  readonly scenery: readonly StaticBox[];
  readonly tissue: PanelTissue;
  /** Each unit's tendon force as a fraction of its maximum, in unit order. */
  readonly tension: ArrayLike<number>;
}

/** The status file's contents for this showcase, as the headset's panel reads them. */
export function showcaseStatus(run: ShowcaseRun): PanelStatus {
  return {
    generation: run.generation,
    scenario: {
      id: `training-${run.name}`,
      title: `Training: ${run.name}, generation ${run.training.generation}`,
    },
    scenarios: [],
    profiles: [],
    profile: run.profile,
    simSeconds: run.upFor,
    wallSeconds: run.wallSeconds,
    speed: 1,
    paused: false,
    muscles: true,
    holding: [],
    grabStrength: 1,
    stepsPerSecond: run.stepsPerSecond,
    fps: run.fps,
    settings: {},
    driveGroups: [],
    diagnostics: {
      kinetic: 0,
      potential: 0,
      driftMm: 0,
      limitsWorst: 0,
      violations: 0,
      contacts: 0,
      costMs: 0,
    },
    groundHeight: run.groundHeight,
    // The scenario's scenery, where the solver has it this tick. It used to be published empty,
    // which told every viewer there was nothing to stand on: a body balancing on a tilting
    // platform appeared to be balancing on nothing, and the thing the run is about was the one
    // thing not on screen.
    staticBoxes: run.scenery.map(staticBoxJson),
    // The discs, the beads and the cartilage, in bone names: what a studio or a headset needs to
    // draw this body's connective tissue from the poses it is already reading.
    tissue: run.tissue,
    training: run.training,
    // Rounded: it is a tint, and a status ten times a second need not carry sixteen digits.
    tension: Array.from(run.tension, (v) => Number(v.toFixed(3))),
  };
}
