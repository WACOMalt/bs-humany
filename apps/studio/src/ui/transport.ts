/**
 * The top bar and the status bar: the Start and Pause toggle and Reset, the mode beside them, the
 * run readout and the event line under the viewport, the keyboard that drives them, and the one
 * question the studio asks before it throws a recording away.
 *
 * What pressing each button does to the run is the run controller's; this is how the buttons
 * look and what they say, and how a run that stopped itself is told.
 */

import type { Simulation } from '@bs-humany/session';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { StudioRuns } from '../runController.js';
import { keyOwnedByTarget } from '../shortcuts.js';
import { askInPage, blurAfterMouse, messageOf, must, setText } from './dom.js';

// ---------------------------------------------------------------------------------------------
// The status bar
// ---------------------------------------------------------------------------------------------

export interface StatusLine {
  /**
   * The run readout: what the run is doing right now, rewritten every frame.
   *
   * Only for the state of the run -- running, paused, at rest, following -- because anything else
   * written here is gone a sixtieth of a second later, when the frame loop writes the readout over
   * it. One-off messages and errors go to `announce`, which has a line of its own.
   */
  setSimulationStatus(text: string, error?: boolean): void;
  /**
   * Say something once, in the status bar's event line, and leave it there.
   *
   * The readout beside it is rewritten every frame, and everything that used to be written into
   * it -- "Wrote the session", "Muscles start with the next run", a failed save, a checkpoint that
   * would not load -- was on screen for one frame and then overwritten by "Running, 3.21 s
   * simulated". So messages have their own line: it holds until the next message replaces it or
   * somebody clicks it away. An error is marked as one and read out at once; the same message
   * sent twice does not rewrite the line, so a log that repeats itself does not churn the page.
   */
  announce(text: string, options?: { error?: boolean }): void;
  /**
   * Say something without taking the line from whatever is already on it.
   *
   * For a message that belongs with the others one action produced rather than in place of them:
   * a loaded session can be refused its run and also lack its checkpoint, and each is worth
   * knowing. What stands keeps its place, and its standing as an error, and the new text follows.
   */
  announceAlongside(text: string): void;
  /** Clear the event line; with `noticesOnly`, leave an error where it is. */
  dismissAnnouncement(noticesOnly?: boolean): void;
}

export function createStatusLine(): StatusLine {
  const status = must<HTMLElement>('#sim-status');
  const slot = must<HTMLElement>('#sim-event');

  const announce = (text: string, options: { error?: boolean } = {}): void => {
    const error = options.error === true;
    if (!slot.hidden && slot.textContent === text && slot.classList.contains('error') === error) {
      return;
    }
    slot.textContent = text;
    slot.classList.toggle('error', error);
    slot.setAttribute('role', error ? 'alert' : 'status');
    slot.title = error
      ? 'Stays until you click it or another message replaces it'
      : 'Click to dismiss';
    slot.hidden = false;
  };

  const dismissAnnouncement = (noticesOnly = false): void => {
    if (noticesOnly && slot.classList.contains('error')) return;
    slot.hidden = true;
    slot.textContent = '';
    slot.classList.remove('error');
  };
  slot.addEventListener('click', () => dismissAnnouncement());

  // Whatever else throws on the page -- a handler, a promise nobody awaited -- says so on the event
  // line too, rather than only in a console nobody has open. Not prevented: the console still gets
  // it, with its stack. The one error that is not an error is the resize observer's notice that it
  // deferred a notification, which browsers raise as one and which a layout that resizes itself in
  // a resize callback (the viewport's does) meets routinely.
  window.addEventListener('error', (event) => {
    if (event.error === null && /ResizeObserver/.test(event.message)) return;
    announce(`Something on the page failed: ${event.message || messageOf(event.error)}`, {
      error: true,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    announce(`Something on the page failed: ${messageOf(event.reason)}`, { error: true });
  });

  return {
    setSimulationStatus(text, error = false) {
      setText(status, text);
      status.classList.toggle('error', error);
    },
    announce,
    announceAlongside(text) {
      if (slot.hidden || !slot.textContent) {
        announce(text);
        return;
      }
      const error = slot.classList.contains('error');
      if (slot.textContent.endsWith(text)) return;
      announce(`${slot.textContent} ${text}`, { error });
    },
    dismissAnnouncement,
  };
}

// ---------------------------------------------------------------------------------------------
// The top bar
// ---------------------------------------------------------------------------------------------

/**
 * The first button's faces, one for each thing a press of it does.
 *
 * It is a toggle: Start with no run, Resume on a paused one, Pause on a live one. It used to be
 * Start, Resume and Restart, with Pause a button of its own beside it, and the Restart face threw
 * the run and its recording away -- a press that on every other face keeps everything. Restarting
 * with the current settings is now the top bar's pending-changes strip's, beside the list of what a
 * restart would change, and a restart there, like Reset, asks before it discards a long recording.
 * Space does what a press does, so each face names it.
 */
export const START_FACES = {
  start: { label: '▶ Start sim', title: 'Start a run with the current settings (Space)' },
  resume: {
    label: '▶ Resume sim',
    title: 'Carry the run on from its newest frame; nothing computed is lost (Space)',
  },
  pause: {
    label: '❚❚ Pause sim',
    title: 'Stop computing; everything computed stays, to scrub and export (Space)',
  },
  compiling: {
    label: 'Compiling…',
    title: 'Building the body and the solver for a new run; the page may stop for a moment',
  },
} as const;

/** What the first button would do if pressed now, from what the run controller knows. */
export interface StartState {
  /** A start is compiling. */
  readonly busy: boolean;
  /** The viewport is following the bridge rather than a run of this page's own. */
  readonly following: boolean;
  /** The run of this page's own, if there is one. */
  readonly run: { readonly paused: boolean; readonly ticks: number } | null;
  /** Whether the playhead is at the live edge. */
  readonly atLiveEdge: boolean;
}

/**
 * What a press of the first button does: start a run, carry a paused or scrubbed one on, pause a
 * live one, or nothing while a start compiles.
 *
 * Following the bridge, a press starts a run of this page's own, which ends the follow: pressing
 * Start there is a plain request for one, and there is no recording of this page's to lose. Space
 * is different, because Space is pressed to pause, and ending somebody's follow for it would be
 * the opposite of what was meant; see `RunController.toggleTransport`.
 */
export function startAction(s: StartState): 'start' | 'resume' | 'pause' | 'none' {
  if (s.busy) return 'none';
  if (s.following || !s.run) return 'start';
  if (s.run.paused || !s.atLiveEdge) return 'resume';
  return 'pause';
}

/**
 * The face for that press. A run at its first tick -- Reset back to it -- reads Start, whatever its
 * paused flag says: there is nothing computed to carry on from, and carrying it on from its first
 * tick is the same run a start would build.
 */
export function startFace(s: StartState): { label: string; title: string } {
  if (s.busy) return START_FACES.compiling;
  const action = startAction(s);
  if (action === 'pause') return START_FACES.pause;
  if (action === 'resume' && s.run && s.run.ticks > 0) return START_FACES.resume;
  return START_FACES.start;
}

/**
 * How long a recording has to be before throwing it away is asked about first.
 *
 * Long enough that a run started a moment ago to look at something is not a question every time
 * it is reset, and short enough that anything somebody meant to keep -- a take, a moment they had
 * scrubbed back to watch -- is asked about. The owner chose "about five seconds".
 */
export const DISCARD_ASK_SECONDS = 5;

/** The part of a run that says how much a discard would lose. */
export interface DiscardableRun {
  readonly dt: number;
  readonly outputFramerate: number;
  /** The export capture: a frame a tick. */
  readonly capture: { readonly frameCount: number };
  /** The sampled trajectory a recording export writes: a sample an output frame. */
  readonly recording: { readonly samples: { readonly length: number } };
}

/**
 * The simulated seconds a discard would throw away: the longer of the two things a run records,
 * the capture of every tick and the trajectory sampled at the output rate, because a run whose
 * capture budget filled long ago still has its whole trajectory to lose.
 */
export function recordingSeconds(run: DiscardableRun): number {
  const captured = run.capture.frameCount * run.dt;
  const sampled = run.outputFramerate > 0 ? run.recording.samples.length / run.outputFramerate : 0;
  return Math.max(captured, sampled);
}

/** Whether throwing this run away is asked about first; see `DISCARD_ASK_SECONDS`. */
export function asksBeforeDiscarding(run: DiscardableRun | null | undefined): boolean {
  return run !== null && run !== undefined && recordingSeconds(run) > DISCARD_ASK_SECONDS;
}

/**
 * The question, for an act named the way its button names it: `Reset`, `Loading this session`.
 * It says what goes, how much of it, and how to keep it, because a dialog that asks only "Are you
 * sure?" is answered by habit.
 */
export function discardQuestion(what: string, seconds: number): string {
  return (
    `${what} throws away this run's ${seconds.toFixed(1)} s recording. ` +
    'Export it first to keep it. Throw it away?'
  );
}

/**
 * Ask whether to throw away a long recording, in a native dialog in the desktop shell and in a
 * dialog of the page's own in a tab (`askInPage`: a browser may not show `window.confirm` at all).
 *
 * The shell's dialog is the dialog plugin's, the one its Save and Load dialogs come from, behind a
 * command of the shell's own (`confirm_discard`) because the plugin's own commands are not open to
 * the page. The page's own dialog is only the fallback, for a command that could not be reached.
 *
 * Only a person at the desktop is ever asked. Every command from the headset reaches the run
 * through a path that does not come here, because a dialog on a screen the person in the headset
 * cannot see would stop the headset's button dead with nothing on it saying why.
 */
async function askToDiscard(message: string): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>('confirm_discard', { message });
    } catch (error) {
      console.error('The native dialog could not be shown; asking in the page instead.', error);
    }
  }
  return askInPage(message, 'Throw it away', 'Keep the run');
}

/** Write a button's label and title, only when they change: this runs every frame. */
export function setFace(button: HTMLButtonElement, face: { label: string; title: string }): void {
  if (button.textContent !== face.label) button.textContent = face.label;
  if (button.title !== face.title) button.title = face.title;
}

/** The overlay checkboxes a followed run has nothing to draw with. */
export interface UnfollowedOverlayBoxes {
  readonly showMuscles: HTMLInputElement;
  readonly showProxies: HTMLInputElement;
  readonly showAxes: HTMLInputElement;
  readonly showCom: HTMLInputElement;
  readonly showContacts: HTMLInputElement;
}

export interface TransportHost {
  readonly runs: StudioRuns;
  readonly status: StatusLine;
  readonly boxes: UnfollowedOverlayBoxes;
  /** Whether the full-detail mesh pack is still on its way. */
  fullDetailPending(): boolean;
  /** Whether the viewport is following the bridge rather than a run of this page's own. */
  following(): boolean;
  /** Every set of run buttons on the page, refreshed together; see `setControls`. */
  setRunControls(running: boolean): void;
}

export type Mode = 'rest' | 'running' | 'paused' | 'following';

export interface Transport {
  readonly buttons: {
    /** Start, Resume and Pause: the one toggle. */
    readonly start: HTMLButtonElement;
    readonly reset: HTMLButtonElement;
    /** The top bar's pending-changes strip's "Restart with changes", shown on every tab. */
    readonly restart: HTMLButtonElement;
    readonly stopFollowing: HTMLButtonElement;
  };
  /**
   * Resolve true when it is all right to throw away the run of this page's own: there is none, or
   * its recording is no longer than `DISCARD_ASK_SECONDS`, or the person said so. `what` names the
   * act the way its button does -- `Reset`, `Loading this session` -- for the question.
   *
   * For a person's own press at the desktop only. Nothing that runs a headset command calls it.
   */
  confirmDiscard(what: string): Promise<boolean>;
  /** Back to the first tick without asking: the headset's Reset. */
  reset(): void;
  /**
   * The top bar's mode: at rest, a run of our own, or following the bridge.
   *
   * The Start and Pause toggle, in the top bar beside it, is about whether this page's simulation
   * is computing; the mode is what the viewport is showing, which while following is nobody's run
   * on this page. So following gets its own way out beside the mode, where the eye already is: the
   * Follow button that starts it is on the Brain tab. At rest, the Overlays popover says what
   * fills it, because every overlay in it draws from a run and at rest they are all empty.
   */
  setMode(mode: Mode): void;
  /**
   * The Start and Pause toggle and Reset, and the mode, for a run that is going or not.
   *
   * The toggle is about whether the simulation is computing; the timeline's buttons are
   * about where in what it has already computed you are looking. They were one set before -- Run,
   * Pause, Step, Reset and a timeline that re-simulated what you scrubbed over -- and the reason
   * that was confusing is that it was two things wearing one set of labels.
   */
  setControls(running: boolean): void;
  /**
   * What the readout says with no run: at rest, and whether the full mesh is still on its way. At
   * rest it says what to press, because a skeleton standing still with every overlay empty is
   * otherwise a page that looks like it has not finished loading.
   */
  restStatus(): string;
  /** A tick run outside `Simulation.advance` threw: pause the run where it stopped and say so. */
  stalled(sim: Simulation, error: unknown): void;
  /** Say, once, that the run stopped itself, and put the buttons in a paused run's state. */
  reportStop(sim: Simulation): void;
  /** The stop's text while the run still stands where it stopped, for the status line. */
  stoppedHere(sim: Simulation): string | undefined;
  /** Something in the run's part of the frame threw: pause the run and say so. */
  frameFailed(sim: Simulation, error: unknown): void;
  /** The run readout for a frame of a run of this page's own. */
  showRunStatus(sim: Simulation): void;
}

export function createTransport(host: TransportHost): Transport {
  const { runs, status } = host;
  const buttons = {
    start: must<HTMLButtonElement>('#simStart'),
    reset: must<HTMLButtonElement>('#reset'),
    restart: must<HTMLButtonElement>('#pending-restart'),
    stopFollowing: must<HTMLButtonElement>('#stop-following'),
  };
  const overlaysAtRest = must<HTMLElement>('#overlays-at-rest');
  const indicator = must<HTMLElement>('#mode-indicator');
  const modeLabel = must<HTMLElement>('#mode-label');

  /**
   * The overlays a followed run has nothing to draw with, what they said before following, and
   * whether they are greyed now; see `setFollowOverlayAvailability`.
   *
   * The bridge carries bones, muscle rings, tension and tissue. Collision proxies, joint axes, the
   * centres of mass, the contacts and the muscle path polylines are all read off a simulation of
   * this page's own, and while following there is none: the boxes stayed live and ticking one did
   * nothing, which reads as a broken overlay rather than one the publisher does not send.
   */
  const unfollowedOverlays = {
    greyed: false,
    boxes: [
      host.boxes.showMuscles,
      host.boxes.showProxies,
      host.boxes.showAxes,
      host.boxes.showCom,
      host.boxes.showContacts,
    ].map((input) => {
      const label = input.closest('label');
      return { input, label, inputTitle: input.title, labelTitle: label?.title ?? '' };
    }),
  };

  /**
   * Grey the overlays with no followed counterpart while following, and give them back after.
   *
   * Only `disabled` and the hover text change, never `checked`: what somebody ticked is what they
   * want for their own runs, and it is remembered for them, so following must not untick it. The
   * label is dimmed with the same `stale` style a readout of another frame gets, because a
   * disabled checkbox greys only its own square and the words beside it read as live. `setMode`
   * runs every frame a run is drawn, so nothing is written unless the answer changes.
   */
  const setFollowOverlayAvailability = (following: boolean): void => {
    if (unfollowedOverlays.greyed === following) return;
    unfollowedOverlays.greyed = following;
    const why = 'Not published on the bridge: drawn only for a run of this studio’s own';
    for (const { input, label, inputTitle, labelTitle } of unfollowedOverlays.boxes) {
      input.disabled = following;
      input.title = following ? why : inputTitle;
      if (label) {
        label.classList.toggle('stale', following);
        label.title = following ? why : labelTitle;
      }
    }
  };

  const setMode = (mode: Mode): void => {
    const stop = buttons.stopFollowing;
    if (stop.hidden !== (mode !== 'following')) stop.hidden = mode !== 'following';
    if (overlaysAtRest.hidden !== (mode !== 'rest')) overlaysAtRest.hidden = mode !== 'rest';
    indicator.classList.toggle('running', mode === 'running');
    indicator.classList.toggle('following', mode === 'following');
    modeLabel.textContent =
      mode === 'following'
        ? 'Following the bridge'
        : mode === 'running'
          ? 'Own run'
          : mode === 'paused'
            ? 'Own run, paused'
            : 'At rest';
    setFollowOverlayAvailability(mode === 'following');
  };

  /**
   * What a run that stopped itself says, in the status line and the event line: a failed tick
   * when there was one, since that stops the run for good, and otherwise the solver's reset.
   */
  const stopText = (sim: Simulation, only?: 'failure' | 'diverged'): string | undefined => {
    if (sim.failure && only !== 'diverged') {
      return (
        `Stopped at ${(sim.failure.tick * sim.dt).toFixed(3)} s: ${sim.failure.message}. ` +
        'Reset to go on.'
      );
    }
    if (sim.divergedAt !== undefined && only !== 'failure') {
      return (
        `Diverged at ${(sim.divergedAt * sim.dt).toFixed(3)} s: MuJoCo reset the body ` +
        '(bad acceleration). Paused.'
      );
    }
    return undefined;
  };

  /**
   * The stop last said, so it is said once: the frame loop asks every frame, and the event line is
   * for saying a thing when it happens, not sixty times a second.
   */
  let reportedStop:
    | { sim: Simulation; failure: Simulation['failure']; diverged: number | undefined }
    | undefined;

  /**
   * The run records why it stopped (`failure`, `divergedAt`); this is only the telling, and it
   * tells each new reason once.
   */
  const reportStop = (sim: Simulation): void => {
    const last = reportedStop;
    if (last?.sim === sim && last.failure === sim.failure && last.diverged === sim.divergedAt) {
      return;
    }
    // Only the solver's reset is new when the failure is the one already told.
    const text =
      last?.sim === sim && last.failure === sim.failure ? stopText(sim, 'diverged') : stopText(sim);
    reportedStop = { sim, failure: sim.failure, diverged: sim.divergedAt };
    if (!text) return;
    status.announce(text, { error: true });
    host.setRunControls(true);
  };

  /**
   * The stop's text while the run is still standing where it stopped, for the status line; once
   * it has been reset or carried on past that tick, the run is an ordinary one again and the
   * event line alone remembers what happened.
   */
  const stoppedHere = (sim: Simulation): string | undefined => {
    if (!sim.paused) return undefined;
    if (sim.failure && sim.ticks === sim.failure.tick) return stopText(sim, 'failure');
    if (sim.divergedAt !== undefined && sim.ticks === sim.divergedAt) {
      return stopText(sim, 'diverged');
    }
    return undefined;
  };

  /** The last message `frameFailed` logged, so a frame that throws every frame logs it once. */
  let lastFrameFailure = '';

  const startState = (): StartState => ({
    busy: runs.busy,
    following: host.following(),
    run: runs.simulation,
    atLiveEdge: runs.atLiveEdge,
  });

  const confirmDiscard = async (what: string): Promise<boolean> => {
    const sim = runs.simulation;
    if (!sim || !asksBeforeDiscarding(sim)) return true;
    // Paused while the question is open, so the recording being asked about does not grow under
    // the dialog, and running again after it whatever the answer: kept, the run goes on as it
    // was; let go, whatever replaces it -- a carry above all, which keeps the run's pause --
    // starts from the state the person left it in rather than from the dialog's.
    const wasRunning = !sim.paused && runs.atLiveEdge;
    if (wasRunning) runs.pause();
    const go = await askToDiscard(discardQuestion(what, recordingSeconds(sim)));
    if (wasRunning && runs.simulation === sim) runs.resume();
    return go;
  };

  buttons.start.addEventListener('click', (event) => {
    blurAfterMouse(event);
    // A toggle, never a restart: nothing a press of this button does throws anything away.
    switch (startAction(startState())) {
      case 'start':
        void runs.start();
        break;
      case 'resume':
        runs.resume();
        break;
      case 'pause':
        runs.pause();
        break;
      default:
        break;
    }
  });
  buttons.reset.addEventListener('click', (event) => {
    blurAfterMouse(event);
    void confirmDiscard('Reset').then((go) => {
      if (go) runs.reset();
      else host.status.announce('Reset cancelled: the run and its recording are kept.');
    });
  });
  // Straight to a new run, not through the toggle, which carries a paused run on: the point here
  // is a run built with the settings as they now stand, paused or not. It is the strip's because
  // that is where the settings a restart would change are listed.
  buttons.restart.addEventListener('click', (event) => {
    blurAfterMouse(event);
    void confirmDiscard('Restarting with the current settings').then((go) => {
      if (go) void runs.start();
      else host.status.announce('Restart cancelled: the run and its recording are kept.');
    });
  });

  return {
    buttons,
    confirmDiscard,
    reset() {
      runs.reset();
    },
    setMode,
    setControls(running) {
      const sim = runs.simulation;
      setMode(!running ? 'rest' : sim?.paused ? 'paused' : 'running');
      // Busy while a start compiles, so a second press cannot begin a second start and the page
      // says why it is about to stop answering for a moment.
      const compiling = runs.busy;
      buttons.start.disabled = compiling;
      if (compiling) buttons.start.setAttribute('aria-busy', 'true');
      else buttons.start.removeAttribute('aria-busy');
      setFace(buttons.start, startFace({ ...startState(), run: running ? sim : null }));
      buttons.reset.disabled = !running;
    },
    restStatus() {
      return host.fullDetailPending()
        ? 'Loading full detail…'
        : 'At rest. Press Start sim to see the muscles work.';
    },
    stalled(sim, error) {
      // Left alone, the frame loop would call the same tick again next frame and the one after,
      // sixty times a second, each throwing into the console while the readout went on saying
      // "Running" over a body that had not moved. Paused, what was computed up to the failure is
      // still there to scrub and export, and the event line says what went wrong and when.
      //
      // `Simulation.advance` catches its own ticks' failures and records them on the run; this is
      // for the ticks run outside it -- a frame stepped by hand -- which are recorded the same
      // way, so the status line and the event line say the one thing whichever path it came by.
      sim.paused = true;
      sim.failure ??= { message: messageOf(error), tick: sim.ticks };
      console.error('A simulation tick failed; the run is paused.', error);
      reportStop(sim);
    },
    reportStop,
    stoppedHere,
    frameFailed(sim, error) {
      // Pause the run where it is -- a paused run draws the same frame every frame, which is the
      // likeliest way out of whatever threw -- and say so on the event line, which does not
      // rewrite itself for the same message.
      const message = messageOf(error);
      if (message !== lastFrameFailure) {
        lastFrameFailure = message;
        console.error('Drawing the run failed; the run is paused.', error);
      }
      sim.paused = true;
      status.announce(
        `Drawing the run failed at ${(sim.ticks * sim.dt).toFixed(3)} s and it is paused: ${message}.`,
        { error: true },
      );
      host.setRunControls(true);
    },
    showRunStatus(sim) {
      const seconds = (sim.ticks * sim.dt).toFixed(2);
      // How fast, never whether anything was lost: nothing is. Below life speed the machine is
      // simply taking longer over the same ticks, and the run it produces is the same run.
      const speed = sim.achievedRateHz / sim.declaredRateHz;
      // A run that stopped itself says why for as long as it stands where it stopped, in red.
      const stopped = stoppedHere(sim);
      status.setSimulationStatus(
        stopped ??
          (sim.paused
            ? `Paused at ${seconds} s.`
            : speed > 0.01 && Math.abs(speed - 1) >= 0.05
              ? `Running, ${seconds} s simulated, at ${speed.toFixed(2)}x life speed.`
              : `Running, ${seconds} s simulated.`),
        stopped !== undefined,
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------------------------

export interface ShortcutHost {
  readonly runs: StudioRuns;
  readonly transport: Transport;
  /** The timeline's buttons, pressed as a click would press them, so a greyed one does nothing. */
  readonly timeline: {
    readonly frameBack: HTMLButtonElement;
    readonly frameForward: HTMLButtonElement;
    readonly goLive: HTMLButtonElement;
  };
  /** Frame the body from where the camera already looks. */
  frameBody(): void;
}

/**
 * Keyboard, as the reference has it: Space for the transport, arrows for a frame, Home for live,
 * the numbers for the views, and F to frame the body from where the camera already is. A focused
 * control keeps the keys it acts on -- Space on a checkbox toggles it, the arrows move a slider --
 * and gives the rest to these.
 */
export function wireShortcuts(host: ShortcutHost): void {
  const { runs, timeline } = host;
  const { start } = host.transport.buttons;
  window.addEventListener('keydown', (event) => {
    // Space on the focused toggle is the transport's Space, not a press of the button. The two do
    // the same on a run of this page's own, but not while following, where a press starts a run
    // of this page's own and Space does nothing; and a Space taken both ways -- the transport's on
    // the key going down, the button's on it coming up -- would pause the run and resume it again.
    if (event.key === ' ' && event.target === start) {
      event.preventDefault();
      if (!event.repeat) runs.toggleTransport();
      return;
    }
    if (keyOwnedByTarget(event.target, event.key)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        // Held down, Space repeats; a transport that toggled at the key-repeat rate would flicker
        // between paused and running and land wherever the finger happened to lift.
        if (event.repeat) return;
        runs.toggleTransport();
        break;
      case 'ArrowLeft':
        if (!timeline.frameBack.disabled) timeline.frameBack.click();
        break;
      case 'ArrowRight':
        if (!timeline.frameForward.disabled) timeline.frameForward.click();
        break;
      case 'Home':
        if (!timeline.goLive.disabled) timeline.goLive.click();
        break;
      case '1':
        window.document.querySelector<HTMLButtonElement>('[data-view="front"]')?.click();
        break;
      case '3':
        window.document.querySelector<HTMLButtonElement>('[data-view="left"]')?.click();
        break;
      case '7':
        window.document.querySelector<HTMLButtonElement>('[data-view="three-quarter"]')?.click();
        break;
      case '9':
        window.document.querySelector<HTMLButtonElement>('[data-view="back"]')?.click();
        break;
      case 'f':
      case 'F':
        host.frameBody();
        break;
      default:
        return;
    }
  });
  // A button activates on Space's release, so the keydown above is not enough on its own to keep
  // the toggle from being pressed a second time by the Space that already toggled it.
  window.addEventListener('keyup', (event) => {
    if (event.key === ' ' && event.target === start) {
      event.preventDefault();
    }
  });
}
