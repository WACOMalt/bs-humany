/**
 * The run of this page's own: which one is going, the playhead over what it has computed, and the
 * one way a run is started, restarted, paused and carried on. Kept free of the DOM so it can be
 * tested with fake runs; the page is told what happened through a host and through change events.
 *
 * One run start at a time is the rule the Start button, Space, a session load and a carry restart
 * all go through.
 *
 * Starting a run is not instant. Building the body is synchronous, but `start()` awaits the
 * physics backend's WebAssembly, and anything can happen in the meantime: a second click on
 * Start, Space pressed during the compile, a session loaded, a slider that restarts the body.
 * Each of those used to begin its own start, and whichever finished last was installed over the
 * others -- with the earlier runs' overlays still in the scene, their muscle lines frozen where
 * they were, and their WebAssembly memory never given back. A start that failed leaked the same
 * way.
 *
 * So every start takes a token. Only the newest token can install its run; a start that finds it
 * has been superseded by the time its `start()` settles disposes what it built and goes away
 * quietly, and a start that fails disposes what it built before the error goes any further.
 */

import type { RunSettings } from './pending.js';
import { Playback } from './playback.js';
import type { SessionFile } from './session.js';
import type { Simulation } from './simulation.js';
import { messageOf } from './ui/dom.js';

/** What a start builds: something that starts asynchronously and can be thrown away. */
export interface StartableRun {
  start(): Promise<void>;
  dispose(): void;
}

/** The generation counter every start is checked against. */
export interface RunGate {
  /** Take the token for a new start, superseding any start still in flight. */
  begin(): number;
  /** Whether a start holding this token is still the one that should land. */
  isCurrent(token: number): boolean;
  /** Abandon whatever start is in flight: a stop, or a follow, wants no run to land. */
  invalidate(): void;
  /** Whether a start that can still land is in flight, which is what the busy Start shows. */
  readonly busy: boolean;
  /** Mark the start holding this token as finished, however it finished. */
  settle(token: number): void;
}

export function createRunGate(): RunGate {
  let current = 0;
  let inFlight = 0;
  return {
    begin() {
      current += 1;
      inFlight = current;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    invalidate() {
      current += 1;
    },
    get busy() {
      return inFlight !== 0 && inFlight === current;
    },
    settle(token) {
      if (token === inFlight) inFlight = 0;
    },
  };
}

/** The steps of one start, in order; see `startSingleFlight`. */
export interface StartSteps<S extends StartableRun> {
  /**
   * Run before anything is built, and checked after: the studio yields here until a frame has
   * painted, so the busy state shows before the compile freezes the page, and a start superseded
   * during the yield never builds at all.
   */
  readonly before?: () => Promise<void>;
  /** Build the run. Synchronous, so what it reads it reads at the moment it is built. */
  readonly build: () => S;
  /** Put the started run in place. Called only for the current token, and only once. */
  readonly install: (run: S) => void;
}

/**
 * Build, start and install one run, unless a newer start supersedes it on the way.
 *
 * Returns the installed run, or undefined when this start was superseded or abandoned. A failure
 * of the current start disposes whatever was built and rethrows, so the caller can say what went
 * wrong; a failure of a start nobody is waiting for any more is disposed and dropped, because
 * reporting it would put an error on screen about a run that was never going to be shown.
 */
export async function startSingleFlight<S extends StartableRun>(
  gate: RunGate,
  steps: StartSteps<S>,
): Promise<S | undefined> {
  const token = gate.begin();
  let run: S | undefined;
  try {
    if (steps.before) {
      await steps.before();
      if (!gate.isCurrent(token)) return undefined;
    }
    run = steps.build();
    await run.start();
    if (!gate.isCurrent(token)) {
      run.dispose();
      return undefined;
    }
    steps.install(run);
    return run;
  } catch (error) {
    run?.dispose();
    if (!gate.isCurrent(token)) return undefined;
    throw error;
  } finally {
    gate.settle(token);
  }
}

/**
 * What a restart takes from the run it replaces into the new body: the joint state, the tick
 * count, and whether it was paused (M5.6).
 */
export interface Carry<S> {
  readonly state: S;
  readonly ticks: number;
  readonly paused: boolean;
}

/** What the controller asks of a run beyond starting and disposing of it. */
export interface ControlledRun<S> extends StartableRun {
  paused: boolean;
  readonly ticks: number;
  /** Ticks one output frame is worth, which is what the playhead counts in. */
  readonly ticksPerOutputFrame: number;
  /** The export capture: a frame a tick. */
  readonly capture: { readonly frameCount: number };
  /** The sampled trajectory a recording export writes. */
  readonly recording: { readonly samples: { readonly length: number } };
  jointState(): S;
  /** Take a carried joint state and tick count; returns the DoFs left at neutral. */
  carryFrom(state: S, ticks: number): string[];
  /** Start a fresh reading of the tick rate. */
  resetRateWindow(): void;
  /** Back to the first tick, the recording thrown away. */
  reset(): void;
}

/**
 * A restore the kernel refused once the run built for it had started: the message is the one the
 * page shows, and the kernel's own words are the cause.
 */
export class RestoreRefused extends Error {}

/**
 * The page around the controller: what it builds a run from, and how it shows one.
 *
 * `R` is the run, `S` its joint state, `W` the settings a run was built with (what the Sim tab
 * compares the panels against), `F` the cord the Spine sliders set, and `Restore` the saved run a
 * session carries.
 */
export interface RunHost<R extends ControlledRun<S>, S, W, F, Restore> {
  /** Whether a run can be built yet: the skeleton has to be on screen first. */
  ready(): boolean;
  /** Whether the viewport is following the bridge rather than a run of this page's own. */
  following(): boolean;
  /** Stop following the bridge, because a run of this page's own is starting. */
  stopFollowing(): void;
  /** The cord the Spine sliders show, which every run is built with. */
  reflex(): F;
  /** The settings the next run would be built with, read at the moment it is built. */
  settings(): W;
  /** Build a run from the panels as they stand, with this cord. Synchronous. */
  build(reflex: F): R;
  /**
   * Everything a started run needs before it is shown: its session settings, and the saved run a
   * session carries when it has one. Returns what the page should say when the saved run did not
   * fit the body built for it, and throws `RestoreRefused` when the kernel refused it part-way.
   */
  prepare(run: R, restoreFrom: Restore | undefined): string | undefined;
  /** Put the installed run on the page; `unmatched` are the DoFs a carry left at neutral. */
  installed(run: R, refused: string | undefined, unmatched: readonly string[]): void;
  /** Take a run's traces off the page; the controller has already let go of it. */
  forgot(): void;
  /** A start was abandoned before there was a run to forget. */
  abandoned(): void;
  /** A start is under way: say so, and resolve once that has been painted. */
  compiling(): Promise<void>;
  /** A start failed, and whatever it built is gone. */
  startFailed(): void;
  /** A start finished, however it finished: the controls follow what is true now. */
  settled(): void;
  /** Let go of whatever the mouse holds on this run. */
  releaseGrab(run: R): void;
  /** Whether this run's body is already the one the sliders describe. */
  sameBody(run: R): boolean;
  /** Say something on the event line. */
  announce(text: string, options?: { error?: boolean }): void;
  /** Clear what the event line says, unless it is an error. */
  dismissNotices(): void;
}

/** What a start in flight was asked to do, so a change to the body while it compiles can ask again. */
interface PendingStart<S, Restore> {
  readonly restoreFrom?: Restore;
  readonly carry?: Carry<S>;
}

export interface RunController<R extends ControlledRun<S>, S, W, Restore> {
  /** The run of this page's own, or null. */
  readonly simulation: R | null;
  /**
   * The settings the running body was built with, which are what a Restart would change and what
   * a saved session's snapshot belongs to. Null with no run.
   */
  readonly compiledWith: W | null;
  /** The playhead over what the run has captured. */
  readonly playback: Playback;
  /**
   * Whether the playhead is at the live edge. It is the whole of the mode: true and the picture
   * is the live simulation, false and it is a frame read back out of the recording. Scrubbing,
   * stepping and playing all set it false and pause the simulation, because the playhead being
   * somewhere the run has already been is exactly what "not live" means.
   */
  readonly atLiveEdge: boolean;
  /** Whether a start that can still land is in flight, which is what the busy Start shows. */
  readonly busy: boolean;
  /** Output frames the recording holds, which is what the playhead counts in. */
  capturedFrames(): number;
  /**
   * The frame on screen, which every control that moves relative to it starts from: the newest
   * at the live edge, the playhead otherwise. See `Playback.at` for why `playback.frame` alone is
   * not it.
   */
  playheadFrame(): number;
  /** Start a run: fresh, from a session's saved run, or carried from the one it replaces. */
  start(restoreFrom?: Restore, carry?: Carry<S>): Promise<void>;
  /** Stop and dispose of the run, and abandon any start still compiling. */
  stop(): void;
  /**
   * Restart a running body in the body the sliders now describe, carrying its pose, its tick count
   * and its pause into it. A run whose body is already that one is left alone unless `always`
   * asks for the restart anyway. With no run, a start still compiling was built from the body as
   * it was, and is asked for again with what it was asked for, so the run that lands is the body
   * the sliders now show.
   *
   * `cause` names what changed, for the message a carry owes: it keeps the pose, but the
   * recording starts again, and a person who has been capturing for a minute should hear that
   * from the page rather than find it out at Export.
   */
  restartWithCarry(cause?: string, options?: { always?: boolean }): Promise<void>;
  /** Stop computing, keeping everything computed. */
  pause(): void;
  /**
   * Carry the run on from its newest frame, which is live again; nothing to do for a run that is
   * already live and running.
   */
  resume(): void;
  /** What Space does: pause a live run, carry a paused one on, start one when there is none. */
  toggleTransport(): void;
  /** Carry a run on, or start one when there is none; never a restart. */
  startOrResume(): void;
  /** Back to the newest frame, and moving with it again. */
  goLive(): void;
  /** Leave live, pause the simulation, and put the playhead where it is being asked for. */
  scrubTo(frame: number): void;
  /** Play the recording from the frame on screen, or stop playing it. */
  togglePlay(): void;
  /** Back to the first tick, paused, at the live edge. */
  reset(): void;
  /** Be told of every change to the transport: a pause, a scrub, going live, play. */
  onChange(listener: () => void): void;
}

export function createRunController<R extends ControlledRun<S>, S, W, F, Restore>(
  host: RunHost<R, S, W, F, Restore>,
): RunController<R, S, W, Restore> {
  const gate = createRunGate();
  const playback = new Playback();
  const listeners: (() => void)[] = [];
  let current: R | null = null;
  let compiledWith: W | null = null;
  let atLiveEdge = true;
  let pendingStart: PendingStart<S, Restore> | null = null;

  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const capturedFrames = (): number =>
    current ? Playback.frames(current.capture.frameCount, current.ticksPerOutputFrame) : 0;

  /** Take a run's traces off the page, without disposing it: whoever calls this has, or will. */
  const forget = (): void => {
    current = null;
    compiledWith = null;
    host.forgot();
  };

  const stop = (): void => {
    // A start still compiling is abandoned too: a stop, a follow or a new start wants no run from
    // before it to land afterwards.
    const wasStarting = gate.busy;
    gate.invalidate();
    pendingStart = null;
    if (!current) {
      if (wasStarting) host.abandoned();
      return;
    }
    current.dispose();
    forget();
  };

  /**
   * Put a started run in place: its settings, its restored or carried state, and everything on
   * the page that shows it. Only ever called for the start that is still current.
   *
   * What can fail is done first, before the run is taken as the current one, so a failure leaves
   * nothing of it on the page.
   */
  const install = (run: R, restoreFrom: Restore | undefined, carry: Carry<S> | undefined) => {
    const refused = host.prepare(run, restoreFrom);
    let unmatched: string[] = [];
    if (carry) {
      unmatched = run.carryFrom(carry.state, carry.ticks);
      run.paused = carry.paused;
      if (unmatched.length > 0) {
        console.warn('DoFs without a counterpart, left at neutral:', unmatched);
      }
    }
    current = run;
    atLiveEdge = true;
    playback.rewind();
    host.installed(run, refused, unmatched);
  };

  const start = async (restoreFrom?: Restore, carry?: Carry<S>): Promise<void> => {
    if (!host.ready()) {
      // Pressed before the bones arrived. It used to do nothing at all, which on a slow
      // connection is indistinguishable from a Start button that does not work.
      host.announce('The skeleton is still loading; Start works once it appears.');
      return;
    }
    if (host.following()) host.stopFollowing();
    stop();
    // What was said about the last run is not about this one. An error stays, because nobody has
    // necessarily read it yet; and a carry is the same run going on, so what was said stays too --
    // a slider dragged through a run carries it several times, and the first carry's notice that
    // the capture was discarded is the one that matters.
    if (!carry) host.dismissNotices();
    pendingStart = { ...(restoreFrom ? { restoreFrom } : {}), ...(carry ? { carry } : {}) };
    // Kept so a failure after the run was put in place can take it out again.
    let built: R | undefined;
    // The settings it was built from, read at the same moment as the build reads them.
    let builtWith: W | undefined;
    // Whether a session's run was refused part-way into its restore, so a fresh one is started.
    let restartFresh = false;
    try {
      const installed = await startSingleFlight(gate, {
        before: () => host.compiling(),
        // Built after the yield, so it reads the settings as they are when it is built: a slider
        // still moving when Start was pressed lands at its final value.
        build: () => {
          built = host.build(host.reflex());
          builtWith = host.settings();
          return built;
        },
        install: (run) => install(run, restoreFrom, carry),
      });
      if (installed && installed === current && builtWith !== undefined) {
        compiledWith = builtWith;
      }
    } catch (error) {
      // The run may have been put in place before something in the installing failed; the gate
      // has disposed it, so it only has to come off the page.
      if (built && current === built) forget();
      if (error instanceof RestoreRefused) {
        // The kernel may refuse a snapshot after it has begun to put it back, and then the run it
        // was given is spent: the gate has disposed it, so no backend is left behind, and a fresh
        // one is built below from the settings the session applied. What the kernel said names
        // channels and modules, which is for the console; the page says what happened.
        console.error('The session’s run could not be restored.', error.cause);
        host.announce(error.message, { error: true });
        restartFresh = true;
      } else {
        console.error('The simulation failed to start.', error);
        host.announce(`The run failed to start: ${messageOf(error)}`, { error: true });
      }
      host.startFailed();
    } finally {
      if (!gate.busy) pendingStart = null;
      // Whichever start this was, the controls follow what is true now: a run, a newer start
      // still compiling, or nothing.
      host.settled();
    }
    if (restartFresh) await start();
  };

  const goLive = (): void => {
    if (!current) return;
    atLiveEdge = true;
    playback.playing = false;
    playback.frame = Math.max(0, capturedFrames() - 1);
    changed();
  };

  const pause = (): void => {
    if (!current) return;
    host.releaseGrab(current);
    current.paused = true;
    changed();
  };

  const resume = (): void => {
    if (!current || (!current.paused && atLiveEdge)) return;
    current.paused = false;
    // The tick rate starts a fresh reading, so the first one after a pause is of the run going
    // again rather than half of it from before the pause.
    current.resetRateWindow();
    goLive();
  };

  const startOrResume = (): void => {
    if (host.following() || gate.busy) return;
    if (current) resume();
    else void start();
  };

  return {
    get simulation() {
      return current;
    },
    get compiledWith() {
      return compiledWith;
    },
    playback,
    get atLiveEdge() {
      return atLiveEdge;
    },
    get busy() {
      return gate.busy;
    },
    capturedFrames,
    playheadFrame: () => playback.at(capturedFrames(), atLiveEdge),
    start,
    stop,
    restartWithCarry(cause = 'Body changed', options = {}) {
      if (!current) {
        const reissue = gate.busy ? pendingStart : null;
        return reissue ? start(reissue.restoreFrom, reissue.carry) : Promise.resolve();
      }
      if (!options.always && host.sameBody(current)) return Promise.resolve();
      const carry = { state: current.jointState(), ticks: current.ticks, paused: current.paused };
      // Both of what a run keeps: the captured frames Export writes, and the sampled trajectory a
      // recording export writes. A run too short to have captured a frame may still have sampled.
      const frames = current.capture.frameCount;
      const samples = current.recording.samples.length;
      const starting = start(undefined, carry);
      // After the start is under way, because a start clears the last run's notices as it begins.
      if (frames > 0 || samples > 0) {
        const what = frames > 0 ? `${frames} captured frames were` : 'its recording was';
        host.announce(
          `${cause}: the run carried on from its pose; ${what} discarded — export first to keep them.`,
        );
      }
      return starting;
    },
    pause,
    resume,
    toggleTransport() {
      // Never a restart, which is only ever a deliberate press of the Restart button, and nothing
      // at all while following the bridge: the body on screen is somebody else's run, and Space
      // used to start one of this page's own over it and end the follow. Nor while a run is
      // compiling: the start in flight is the answer to the last press.
      if (host.following() || gate.busy) return;
      if (current && !current.paused) pause();
      else startOrResume();
    },
    startOrResume,
    goLive,
    scrubTo(frame) {
      if (!current) return;
      const frames = capturedFrames();
      if (frames <= 0) return;
      host.releaseGrab(current);
      atLiveEdge = false;
      playback.playing = false;
      current.paused = true;
      playback.frame = Math.min(Math.max(frame, 0), frames - 1);
      changed();
    },
    togglePlay() {
      if (!current || capturedFrames() <= 1) return;
      if (playback.playing) {
        playback.playing = false;
      } else {
        // From the frame on screen: live, that is the newest, and replaying from the end plays
        // nothing, so a Play pressed there starts over. It used to start from wherever the
        // playhead was last left, which after going live and running on was nowhere in particular.
        const from = playback.at(capturedFrames(), atLiveEdge);
        host.releaseGrab(current);
        atLiveEdge = false;
        current.paused = true;
        playback.frame = from >= capturedFrames() - 1 ? 0 : from;
        playback.playing = true;
      }
      changed();
    },
    reset() {
      if (!current) return;
      current.reset();
      current.paused = true;
      goLive();
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

/** The studio's own controller: over simulations, restoring a session's saved run. */
export type StudioRuns = RunController<
  Simulation,
  ReturnType<Simulation['jointState']>,
  RunSettings,
  NonNullable<SessionFile['simulation']>
>;
