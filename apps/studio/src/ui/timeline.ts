/**
 * The timeline under the viewport: the playhead over what the run has captured, Play, a frame
 * back and on, and Live.
 *
 * These are about where in what the run has already computed you are looking, not about whether
 * it is computing: that is Start and Pause, in the top bar. Where the playhead is, and whether it
 * is at the live edge, is the run controller's; this draws it and hands it the clicks.
 */

import { Playback } from '../playback.js';
import type { StudioRuns } from '../runController.js';
import type { Simulation } from '../simulation.js';
import { blurAfterMouse, must, setText } from './dom.js';

/**
 * Whether the capture's newest frame is the run's newest tick: false once the capture budget has
 * stopped it and the run has gone on past it. Then the newest frame is not live, and nothing
 * computed from here on is recorded, so the timeline stops calling itself live and ▶ stops
 * offering to compute a frame onto the end of it. An empty capture nothing has stopped is at the
 * edge, because the next tick is its first; see `Playback.atLiveEdge`.
 */
export function captureAtLiveEdge(sim: Simulation): boolean {
  const stopped = sim.capturesStoppedBy !== undefined || sim.capture.full;
  return Playback.atLiveEdge(sim.capture, stopped, sim.ticks);
}

export interface TimelineHost {
  readonly runs: StudioRuns;
  /** A tick run by hand threw: pause the run where it stopped and say so. */
  stalled(sim: Simulation, error: unknown): void;
}

export interface Timeline {
  readonly buttons: {
    readonly playToggle: HTMLButtonElement;
    readonly frameBack: HTMLButtonElement;
    readonly frameForward: HTMLButtonElement;
    readonly goLive: HTMLButtonElement;
  };
  /** The region the timeline sits in, shown only while there is a run to have captured anything. */
  readonly control: HTMLElement;
  /**
   * The playhead and its label.
   *
   * The time is the run's -- the tick the frame shows, times the tick length -- and not the frame
   * divided by the output rate, which counted from the start of the capture: after a carry or a
   * session load the capture starts where the body arrived, and the label then disagreed with the
   * status line's "Paused at" by however far in that was.
   *
   * "Live" only when the frame on screen is the run's newest tick. With the capture budget spent
   * the run can carry on unrecorded, and the timeline used to go on saying "live" over a frame that
   * was seconds behind the body; it now says the recording stopped and where the run is.
   */
  update(sim: Simulation): void;
  /**
   * The playback buttons, refreshed every frame rather than only when one is pressed.
   *
   * Whether there is anything to play back changes as the run computes, and nothing presses a
   * button when it does: left to the run controls alone, Play stayed greyed out through a whole
   * run because the last thing to refresh it was the run starting, when the recording was empty.
   */
  setPlaybackControls(running: boolean): void;
}

export function createTimeline(host: TimelineHost): Timeline {
  const { runs } = host;
  const slider = must<HTMLInputElement>('#timeline');
  const buttons = {
    playToggle: must<HTMLButtonElement>('#playToggle'),
    frameBack: must<HTMLButtonElement>('#frameBack'),
    frameForward: must<HTMLButtonElement>('#frameForward'),
    goLive: must<HTMLButtonElement>('#goLive'),
  };
  const value = must<HTMLOutputElement>('#timeline-value');
  const note = must<HTMLElement>('#playback-note');

  const setPlaybackControls = (running: boolean): void => {
    const frames = runs.capturedFrames();
    const { playback } = runs;
    buttons.playToggle.disabled = frames <= 1;
    buttons.playToggle.textContent = playback.playing ? 'Pause' : 'Play';
    buttons.frameBack.disabled =
      frames <= 0 || (runs.atLiveEdge ? frames <= 1 : playback.frame < 1);
    buttons.frameForward.disabled = !running;
    // What ▶ does at the end of the recording depends on whether the recording is still being
    // taken, and its title is where somebody hovering to find out would look.
    const sim = runs.simulation;
    const title =
      sim && !captureAtLiveEdge(sim)
        ? 'One output frame on; the recording has stopped, so at its end this goes back to live ' +
          'without computing (Right)'
        : 'One output frame on; at the end of the recording, computes one (Right)';
    if (buttons.frameForward.title !== title) buttons.frameForward.title = title;
    buttons.goLive.disabled = !running || runs.atLiveEdge;
  };

  let scrubbing = false;
  slider.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  slider.addEventListener('input', () => {
    runs.scrubTo(Number(slider.value));
  });
  window.addEventListener('pointerup', () => {
    scrubbing = false;
  });

  buttons.playToggle.addEventListener('click', (event) => {
    blurAfterMouse(event);
    runs.togglePlay();
  });
  buttons.frameBack.addEventListener('click', (event) => {
    blurAfterMouse(event);
    // One back from the frame on screen. From live this used to step back from the stale
    // playhead, which after a few seconds of running was the start of the capture.
    runs.scrubTo(runs.playheadFrame() - 1);
  });
  buttons.frameForward.addEventListener('click', (event) => {
    blurAfterMouse(event);
    const sim = runs.simulation;
    if (!sim) return;
    const frames = runs.capturedFrames();
    const at = runs.playheadFrame();
    if (at < frames - 1) {
      runs.scrubTo(at + 1);
      return;
    }
    // At the newest recorded frame with the capture stopped behind the run, a computed frame
    // would not be recorded and the playhead could not show it; all that is ahead is live.
    if (!captureAtLiveEdge(sim)) {
      runs.goLive();
      return;
    }
    // At the newest frame there is nothing ahead to step to, so one is computed. That is what the
    // old Step button did, and it is the same gesture: go one frame further on.
    sim.paused = true;
    const ticks = Math.max(1, Math.round(sim.ticksPerOutputFrame));
    try {
      for (let i = 0; i < ticks; i++) sim.tick();
    } catch (error) {
      host.stalled(sim, error);
      return;
    }
    sim.pose.step();
    sim.metrics.step();
    // The belly sweep runs on a divisor while the simulation is running; a hand-stepped frame
    // asks for it directly so what is drawn is this tick's shape rather than up to eight back.
    sim.sweepRenderMesh();
    runs.goLive();
  });
  buttons.goLive.addEventListener('click', (event) => {
    blurAfterMouse(event);
    runs.goLive();
  });

  return {
    buttons,
    control: must<HTMLElement>('#timeline-control'),
    update(sim) {
      const frames = runs.capturedFrames();
      const frame = runs.playheadFrame();
      slider.max = String(Math.max(0, frames - 1));
      if (!scrubbing) slider.value = String(frame);
      const fps = Math.max(1, sim.outputFramerate);
      const seconds =
        Playback.runTickOf(frame, sim.capture.firstTick, sim.ticksPerOutputFrame) * sim.dt;
      const edge = !runs.atLiveEdge
        ? ''
        : captureAtLiveEdge(sim)
          ? ' · live'
          : ` · recording stopped; run at ${(sim.ticks * sim.dt).toFixed(2)} s`;
      setText(
        value,
        frames === 0 ? '—' : `frame ${frame} of ${frames - 1} · ${seconds.toFixed(2)} s${edge}`,
      );
      setText(
        note,
        frames === 0
          ? ''
          : `${frames} frames recorded at ${fps} fps, ${(frames / fps).toFixed(2)} s` +
              (runs.atLiveEdge
                ? '.'
                : ' — the simulation is paused while the playhead is behind it.'),
      );
      setPlaybackControls(true);
    },
    setPlaybackControls,
  };
}
