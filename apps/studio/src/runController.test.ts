/**
 * One run start at a time, with fake runs whose `start()` the test resolves by hand, so every
 * ordering of two overlapping starts can be forced rather than hoped for.
 */

import { describe, expect, it } from 'vitest';
import {
  type ControlledRun,
  type RunHost,
  type StartableRun,
  createRunController,
  createRunGate,
  startSingleFlight,
} from './runController.js';

class FakeRun implements StartableRun {
  disposed = 0;
  private settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
  readonly started = new Promise<void>((resolve, reject) => {
    this.settle = { resolve, reject };
  });
  start(): Promise<void> {
    return this.started;
  }
  resolve(): void {
    this.settle?.resolve();
  }
  reject(error: Error): void {
    this.settle?.reject(error);
  }
  dispose(): void {
    this.disposed += 1;
  }
}

/** Let every settled promise's continuations run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function overlapping() {
  const gate = createRunGate();
  const installed: FakeRun[] = [];
  const first = new FakeRun();
  const second = new FakeRun();
  const one = startSingleFlight(gate, { build: () => first, install: (r) => installed.push(r) });
  const two = startSingleFlight(gate, { build: () => second, install: (r) => installed.push(r) });
  return { gate, installed, first, second, one, two };
}

describe('startSingleFlight', () => {
  it('installs only the newer of two starts when the older finishes first', async () => {
    const { gate, installed, first, second, one, two } = overlapping();
    expect(gate.busy).toBe(true);
    first.resolve();
    await flush();
    second.resolve();
    expect(await one).toBeUndefined();
    expect(await two).toBe(second);
    expect(installed).toEqual([second]);
    expect(first.disposed).toBe(1);
    expect(second.disposed).toBe(0);
    expect(gate.busy).toBe(false);
  });

  it('installs only the newer of two starts when the newer finishes first', async () => {
    const { installed, first, second, one, two } = overlapping();
    second.resolve();
    await flush();
    first.resolve();
    expect(await two).toBe(second);
    expect(await one).toBeUndefined();
    expect(installed).toEqual([second]);
    expect(first.disposed).toBe(1);
    expect(second.disposed).toBe(0);
  });

  it('disposes a failed start and passes its error on', async () => {
    const gate = createRunGate();
    const run = new FakeRun();
    const installed: FakeRun[] = [];
    const starting = startSingleFlight(gate, {
      build: () => run,
      install: (r) => installed.push(r),
    });
    run.reject(new Error('no WebAssembly'));
    await expect(starting).rejects.toThrow('no WebAssembly');
    expect(run.disposed).toBe(1);
    expect(installed).toEqual([]);
    expect(gate.busy).toBe(false);
  });

  it('drops a failure nobody is waiting for any more', async () => {
    const { installed, first, second, one, two } = overlapping();
    first.reject(new Error('superseded anyway'));
    expect(await one).toBeUndefined();
    expect(first.disposed).toBe(1);
    second.resolve();
    expect(await two).toBe(second);
    expect(installed).toEqual([second]);
  });

  it('lands nothing after the gate is invalidated, and is not busy', async () => {
    const { gate, installed, first, second, one, two } = overlapping();
    gate.invalidate();
    expect(gate.busy).toBe(false);
    first.resolve();
    second.resolve();
    expect(await one).toBeUndefined();
    expect(await two).toBeUndefined();
    expect(installed).toEqual([]);
    expect(first.disposed).toBe(1);
    expect(second.disposed).toBe(1);
  });

  it('never builds a start superseded while it yields', async () => {
    const gate = createRunGate();
    let built = 0;
    let release: () => void = () => undefined;
    const yielded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = startSingleFlight(gate, {
      before: () => yielded,
      build: () => {
        built += 1;
        return new FakeRun();
      },
      install: () => undefined,
    });
    gate.invalidate();
    release();
    expect(await stale).toBeUndefined();
    expect(built).toBe(0);
  });
});

/** A cord, as the Spine sliders give it: one gain is enough to tell two apart. */
interface Cord {
  readonly stretch: number;
}

/** The joint state a fake run carries: its own tick count, so a carry can be checked end to end. */
interface FakeState {
  readonly ticks: number;
}

/** A run that starts at once and records what it was built and carried with. */
class ControlledFake implements ControlledRun<FakeState> {
  paused = false;
  ticks = 0;
  ticksPerOutputFrame = 1;
  disposed = 0;
  rateWindowsReset = 0;
  resets = 0;
  carriedFrom: FakeState | undefined;
  readonly capture = { frameCount: 0 };
  readonly recording = { samples: [] as unknown[] };
  constructor(readonly reflex: Cord) {}
  start(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): void {
    this.disposed += 1;
  }
  jointState(): FakeState {
    return { ticks: this.ticks };
  }
  carryFrom(state: FakeState, ticks: number): string[] {
    this.carriedFrom = state;
    this.ticks = ticks;
    return [];
  }
  resetRateWindow(): void {
    this.rateWindowsReset += 1;
  }
  reset(): void {
    this.resets += 1;
    this.ticks = 0;
    this.capture.frameCount = 0;
  }
}

/** A controller over fake runs, and the page it would be telling: every call to it written down. */
function controlled() {
  const runs: ControlledFake[] = [];
  const said: string[] = [];
  const grabsReleased: ControlledFake[] = [];
  const page = {
    cord: { stretch: 1 } as Cord,
    settings: 'as built',
    following: false,
    sameBody: false,
    changes: 0,
  };
  const host: RunHost<ControlledFake, FakeState, string, Cord, never> = {
    ready: () => true,
    following: () => page.following,
    stopFollowing: () => {
      page.following = false;
    },
    reflex: () => page.cord,
    settings: () => page.settings,
    build: (reflex) => {
      const run = new ControlledFake(reflex);
      runs.push(run);
      return run;
    },
    prepare: () => undefined,
    installed: () => undefined,
    forgot: () => undefined,
    abandoned: () => undefined,
    compiling: () => Promise.resolve(),
    startFailed: () => undefined,
    settled: () => undefined,
    releaseGrab: (run) => grabsReleased.push(run),
    sameBody: () => page.sameBody,
    announce: (text) => said.push(text),
    dismissNotices: () => undefined,
  };
  const run = createRunController(host);
  run.onChange(() => {
    page.changes += 1;
  });
  return { run, runs, said, grabsReleased, page };
}

describe('createRunController', () => {
  it('builds a run with the cord the panel shows and remembers what it was built with', async () => {
    const { run, runs, page } = controlled();
    page.cord = { stretch: 2.5 };
    await run.start();
    expect(runs).toHaveLength(1);
    expect(run.simulation).toBe(runs[0]);
    expect(runs[0]?.reflex).toEqual({ stretch: 2.5 });
    expect(run.compiledWith).toBe('as built');
    expect(run.atLiveEdge).toBe(true);
  });

  it('carries the tick count, the pause and the cord into the restarted body', async () => {
    const { run, runs, said, page } = controlled();
    await run.start();
    const first = runs[0] as ControlledFake;
    first.ticks = 420;
    first.capture.frameCount = 12;
    run.pause();
    // The cord moved since the first run was built: the restart is built with the new one.
    page.cord = { stretch: 3 };
    page.settings = 'after the change';
    await run.restartWithCarry('Body changed');
    expect(runs).toHaveLength(2);
    const second = runs[1] as ControlledFake;
    expect(run.simulation).toBe(second);
    expect(first.disposed).toBe(1);
    expect(second.carriedFrom).toEqual({ ticks: 420 });
    expect(second.ticks).toBe(420);
    expect(second.paused).toBe(true);
    expect(second.reflex).toEqual({ stretch: 3 });
    expect(run.compiledWith).toBe('after the change');
    // The recording did not survive the carry, and the page is told so.
    expect(said.at(-1)).toMatch(/^Body changed: .*12 captured frames were discarded/);
  });

  it('leaves a run alone when its body is already the one asked for, unless told to restart', async () => {
    const { run, runs, page } = controlled();
    await run.start();
    page.sameBody = true;
    await run.restartWithCarry();
    expect(runs).toHaveLength(1);
    await run.restartWithCarry('Settings applied', { always: true });
    expect(runs).toHaveLength(2);
  });

  it('pauses and resumes the same run, at the live edge', async () => {
    const { run, runs, grabsReleased, page } = controlled();
    await run.start();
    const only = runs[0] as ControlledFake;
    only.ticks = 30;
    only.capture.frameCount = 30;
    const changesBefore = page.changes;

    run.toggleTransport();
    expect(only.paused).toBe(true);
    expect(grabsReleased).toEqual([only]);
    expect(page.changes).toBeGreaterThan(changesBefore);

    run.toggleTransport();
    expect(only.paused).toBe(false);
    expect(only.rateWindowsReset).toBe(1);
    expect(run.atLiveEdge).toBe(true);
    expect(run.playheadFrame()).toBe(29);
    // Carried on, never restarted: still the one run, nothing disposed.
    expect(runs).toHaveLength(1);
    expect(only.disposed).toBe(0);
  });

  it('leaves the live edge on a scrub and comes back to it on resume', async () => {
    const { run, runs } = controlled();
    await run.start();
    const only = runs[0] as ControlledFake;
    only.capture.frameCount = 10;
    run.scrubTo(3);
    expect(run.atLiveEdge).toBe(false);
    expect(only.paused).toBe(true);
    expect(run.playheadFrame()).toBe(3);
    run.resume();
    expect(run.atLiveEdge).toBe(true);
    expect(only.paused).toBe(false);
    expect(run.playheadFrame()).toBe(9);
  });

  it('does nothing on Space while following the bridge', async () => {
    const { run, runs, page } = controlled();
    page.following = true;
    run.toggleTransport();
    await Promise.resolve();
    expect(runs).toHaveLength(0);
    expect(run.simulation).toBeNull();
  });

  it('forgets the run and what it was built with on a stop', async () => {
    const { run, runs } = controlled();
    await run.start();
    run.stop();
    expect(runs[0]?.disposed).toBe(1);
    expect(run.simulation).toBeNull();
    expect(run.compiledWith).toBeNull();
  });
});
