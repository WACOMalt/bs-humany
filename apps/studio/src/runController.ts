/**
 * One run start at a time: the rule the Start button, Space, a session load and a carry restart
 * all go through, kept free of the DOM so it can be tested with fake runs.
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
