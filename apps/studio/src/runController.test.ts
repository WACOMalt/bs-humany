/**
 * One run start at a time, with fake runs whose `start()` the test resolves by hand, so every
 * ordering of two overlapping starts can be forced rather than hoped for.
 */

import { describe, expect, it } from 'vitest';
import { type StartableRun, createRunGate, startSingleFlight } from './runController.js';

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
