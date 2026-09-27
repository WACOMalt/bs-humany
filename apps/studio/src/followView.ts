/**
 * Following the bridge: the body on screen is whoever is publishing, not a run of our own.
 *
 * The follower (`follow.ts`) reads the bridge; this draws what it read -- the publisher's body,
 * its muscle volumes, its connective tissue and its scenery -- and says in the status line whose
 * run it is.
 */

import type { BridgeFollower } from './follow.js';
import { FollowTissue } from './followTissue.js';
import { RingTubes } from './ringTubes.js';
import type { StudioRuns } from './runController.js';
import type { StudioScene } from './scene.js';
import type { Controls } from './sessionWiring.js';
import type { TissueTable } from './tissue.js';
import type { BodyPanel } from './ui/bodyPanel.js';
import { blurAfterMouse, must } from './ui/dom.js';
import type { StatusLine, Transport } from './ui/transport.js';

/**
 * How far a followed body's stature may be from the skeleton drawn for it before the page says
 * so, as a fraction. A display tolerance, not a measurement: above the 2.5 mm that the Stature
 * slider's 5 mm step can leave between its nearest setting and any publisher's body, so the advice
 * the note gives can always clear it, and about where a misfit between the drawn bones and the
 * published joints starts to be visible as a gap or an overlap.
 */
const FOLLOW_STATURE_TOLERANCE = 0.005;

export interface FollowViewHost {
  readonly follower: BridgeFollower;
  readonly scene: StudioScene;
  readonly controls: Controls;
  readonly runs: StudioRuns;
  readonly body: BodyPanel;
  readonly status: StatusLine;
  readonly transport: Transport;
  /** Every set of run buttons on the page, refreshed together. */
  setRunControls(running: boolean): void;
}

export interface FollowView {
  /** The Follow button on the Brain tab, which starts and stops following. */
  readonly button: HTMLButtonElement;
  /** Draw the publisher's newest frame; for every frame the page draws while following. */
  frame(): void;
  /** Stop following, and put back whatever this page's own run is doing. */
  stop(): void;
  /**
   * Follow the bridge, or stop, without asking: the headset's Follow and a training start's. A
   * press of the button asks first when following would throw away a long recording.
   */
  toggle(): void;
  /** A new skin was built: pose it on the publisher's next frame, whatever tick that is. */
  skinRebuilt(): void;
}

export function createFollowView(host: FollowViewHost): FollowView {
  const { follower, scene, controls: ui, body, status, transport } = host;
  const button = must<HTMLButtonElement>('#follow-bridge');
  let tubes: RingTubes | null = null;
  /** The followed body's connective tissue, and what it was built for. */
  let tissue: FollowTissue | null = null;
  let tissueKey = '';
  let lastTick = -1;
  let lastMuscleTick = -1;
  /**
   * The tension array the followed tubes were last tinted from. The status brings a new one ten
   * times a second and the page draws sixty, so tinting every frame recoloured every ring five
   * times out of six from numbers it had already drawn.
   */
  let tintedFrom: ArrayLike<number> | null = null;

  /**
   * What the status line owes about a followed body the page cannot draw as it is, or nothing.
   *
   * A publisher that says what body it built is drawn as that body (see `frame`). One that does
   * not -- another studio, an older publisher -- is drawn on this studio's own skeleton, at the
   * sliders' stature, and the only thing that says how tall it really is is its bridge's header.
   * Where the two disagree the bones will not meet at the joints, and the line says so and what
   * would fix it. It never moves the sliders itself: they are this studio's settings, and changing
   * them behind somebody's back would change their next run as well.
   */
  const followedBodyNote = (): string => {
    const assets = body.assets;
    if (follower.body || !assets) return '';
    const scale = follower.datasetScale;
    if (scale === null) return '';
    const theirs = scale * assets.manifest.subjectStature;
    const ours = Number(ui.stature.value);
    if (Math.abs(theirs - ours) <= FOLLOW_STATURE_TOLERANCE * ours) return '';
    return (
      ` · the publisher's body is ${theirs.toFixed(2)} m, drawn on this studio's ` +
      `${ours.toFixed(2)} m skeleton: set Stature to match`
    );
  };

  /**
   * The followed body's tissue: built from the table the publisher puts in its status, rebuilt
   * when the publisher or its body changes, and hidden with the overlay it belongs to. A
   * publisher that says nothing of tissue -- an older one -- simply has none to draw.
   */
  const tissueFrame = (pose: typeof follower.pose): void => {
    const table = (follower.status as { tissue?: TissueTable } | null)?.tissue;
    const key =
      pose && table ? `${pose.bones.length}:${table.discs.length}:${table.bars.length}` : '';
    if (key !== tissueKey) {
      tissueKey = key;
      if (tissue) {
        tissue.dispose();
        tissue = null;
      }
      if (pose && table && (table.discs.length > 0 || table.bars.length > 0)) {
        tissue = new FollowTissue(table, pose.bones);
        scene.world.add(tissue.root);
      }
    }
    if (!tissue || !pose) return;
    tissue.root.visible = ui.showTissue.checked;
    if (tissue.root.visible) tissue.update(pose.position, pose.orientation);
  };

  /**
   * The scenery a publisher on the bridge is standing its body on.
   *
   * Followed runs used to have none: the studio drew furniture from its own simulation, and while
   * following there is no simulation. So a body balancing on a tilting platform appeared to be
   * balancing on nothing, and the thing a balance run is about was the one thing not on screen.
   *
   * The status carries the boxes where the publisher's solver has them, ten times a second. The
   * meshes are rebuilt only when the shapes change -- a tilting platform keeps its size and moves
   * every frame -- so the common case is moving what is already there.
   */
  const followedFurniture = (): void => {
    const published = follower.status as {
      staticBoxes?: readonly {
        halfExtents: readonly number[];
        position: readonly number[];
        rotation?: readonly number[];
      }[];
    } | null;
    scene.furniture.keep(
      (published?.staticBoxes ?? []).map((b) => ({
        halfExtents: {
          x: b.halfExtents[0] ?? 0,
          y: b.halfExtents[1] ?? 0,
          z: b.halfExtents[2] ?? 0,
        },
        position: { x: b.position[0] ?? 0, y: b.position[1] ?? 0, z: b.position[2] ?? 0 },
        rotation: b.rotation
          ? {
              x: b.rotation[0] ?? 0,
              y: b.rotation[1] ?? 0,
              z: b.rotation[2] ?? 0,
              w: b.rotation[3] ?? 1,
            }
          : undefined,
      })),
    );
  };

  const stop = (): void => {
    follower.stop();
    if (tissue) {
      tissue.dispose();
      tissue = null;
      tissueKey = '';
    }
    if (tubes) {
      tubes.dispose();
      tubes = null;
    }
    lastTick = -1;
    lastMuscleTick = -1;
    tintedFrom = null;
    // The publisher's scenery was theirs, not this studio's: it goes with them.
    scene.furniture.clear();
    // And so was its body. The follower has forgotten it, so this builds the sliders' body again
    // -- which nothing changed while following -- or nothing, if the two were the same.
    body.rebuildMesh();
    body.skinned?.rest();
    button.textContent = 'Follow bridge';
    // Back to whatever this page's own run is doing, which with nothing running is nothing.
    const sim = host.runs.simulation;
    transport.setMode(!sim ? 'rest' : sim.paused ? 'paused' : 'running');
    status.setSimulationStatus(transport.restStatus());
  };

  // The mode indicator's own way out of following, which is the Follow button pressed again: one
  // path in and out, so the headset's Follow toggle and this stay the same act.
  transport.buttons.stopFollowing.addEventListener('click', (event) => {
    blurAfterMouse(event);
    if (follower.active) button.click();
  });
  const begin = (): void => {
    // A run of our own and a followed one cannot share the skeleton.
    host.runs.stop();
    host.setRunControls(false);
    follower.start();
    button.textContent = 'Stop following';
    transport.setMode('following');
    status.setSimulationStatus('Following the bridge…');
  };
  const toggle = (): void => {
    if (follower.active) stop();
    else begin();
  };
  button.addEventListener('click', () => {
    if (follower.active) {
      stop();
      return;
    }
    // Following throws this page's own run away, so a person's press asks first when that run
    // has recorded more than a few seconds. The headset's Follow comes through `toggle` instead:
    // the question would open on a screen the person in the headset cannot see.
    void transport.confirmDiscard('Following the bridge').then((go) => {
      if (go && !follower.active) begin();
    });
  });

  return {
    button,
    toggle,
    frame() {
      // The publisher's body first, so the pose below lands on the skin it belongs to. `body`
      // keeps its identity while the body does, so this builds only when the publisher changes
      // body.
      const published = follower.body;
      if (published && body.assets && !body.builtFor(published.key)) {
        body.buildSkin(published.morphology);
        body.updateReadouts(Number(ui.stature.value), Number(ui.mass.value));
      }
      const skin = body.skinned;
      const pose = follower.pose;
      if (skin && pose && pose.tick !== lastTick) {
        lastTick = pose.tick;
        skin.update(pose.bones, pose.position, pose.orientation);
      }
      tissueFrame(pose);
      const muscles = follower.muscles;
      if (muscles && muscles.tick !== lastMuscleTick) {
        lastMuscleTick = muscles.tick;
        if (
          !tubes ||
          tubes.mesh.geometry.getAttribute('position').count !==
            muscles.units * muscles.rings * muscles.segments
        ) {
          if (tubes) tubes.dispose();
          tubes = new RingTubes(muscles.units, muscles.rings, muscles.segments);
          scene.world.add(tubes.mesh);
          // New tubes are untinted, whatever the last ones were.
          tintedFrom = null;
        }
        tubes.update(muscles.position, muscles.orientation, muscles.radius);
      }
      if (tubes) {
        // The followed tubes are the muscle volumes, and answer to the same box as a run's own.
        tubes.mesh.visible = ui.showMuscleVolumes.checked;
        const tension = follower.tension;
        if (tension && tension !== tintedFrom) {
          tintedFrom = tension;
          tubes.tint(tension);
        }
      }
      followedFurniture();
      const said = follower.status as {
        scenario?: { title?: string };
        training?: { generation?: number; episode?: number };
      } | null;
      const title = said?.scenario?.title ?? 'a publisher';
      const training = said?.training;
      const problem = follower.problem;
      // The publisher's own simulated seconds, from its frame. The tick over 500 was only right
      // for a 2 ms step; the anatomical profile steps at 1 ms, and its runs read twice their time.
      status.setSimulationStatus(
        problem
          ? `Following the bridge: ${problem}`
          : `Following ${title}${training ? `, episode ${training.episode}` : ''}` +
              (pose ? ` · ${pose.simTime.toFixed(1)} s` : '') +
              followedBodyNote(),
        problem !== null,
      );
    },
    stop,
    skinRebuilt() {
      lastTick = -1;
    },
  };
}
