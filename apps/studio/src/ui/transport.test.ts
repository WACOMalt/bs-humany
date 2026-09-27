/**
 * The first button's toggle, and when throwing a recording away is asked about first.
 *
 * The first button used to read Restart on a live run and throw the run and its recording away
 * when pressed, the one face of it that lost anything. It is a Start/Resume and Pause toggle now,
 * and a press of it never discards; Reset, the pending-changes strip's restart, Load, Follow and a
 * checkpoint's set-up do, and a recording longer than about five seconds is asked about first.
 */

import { describe, expect, it } from 'vitest';
import {
  DISCARD_ASK_SECONDS,
  START_FACES,
  type StartState,
  asksBeforeDiscarding,
  discardQuestion,
  recordingSeconds,
  startAction,
  startFace,
} from './transport.js';

const live: StartState = {
  busy: false,
  following: false,
  run: { paused: false, ticks: 1200 },
  atLiveEdge: true,
};

describe('the Start and Pause toggle', () => {
  it('starts with no run, pauses a live one and carries a paused one on', () => {
    expect(startAction({ ...live, run: null })).toBe('start');
    expect(startFace({ ...live, run: null })).toBe(START_FACES.start);
    expect(startAction(live)).toBe('pause');
    expect(startFace(live)).toBe(START_FACES.pause);
    const paused = { ...live, run: { paused: true, ticks: 1200 } };
    expect(startAction(paused)).toBe('resume');
    expect(startFace(paused)).toBe(START_FACES.resume);
  });

  it('never restarts: no face of it throws anything away', () => {
    for (const face of Object.values(START_FACES)) {
      expect(face.label).not.toMatch(/restart/i);
      expect(face.title).not.toMatch(/throw|discard/i);
    }
  });

  it('carries a scrubbed run on from its newest frame', () => {
    expect(startAction({ ...live, run: { paused: true, ticks: 900 }, atLiveEdge: false })).toBe(
      'resume',
    );
  });

  it('reads Start on a run Reset back to its first tick, which it carries on from there', () => {
    const reset = { ...live, run: { paused: true, ticks: 0 } };
    expect(startAction(reset)).toBe('resume');
    expect(startFace(reset)).toBe(START_FACES.start);
  });

  it('does nothing while a start compiles, and says it is compiling', () => {
    expect(startAction({ ...live, busy: true })).toBe('none');
    expect(startFace({ ...live, busy: true })).toBe(START_FACES.compiling);
  });

  it('starts a run of this page’s own when pressed while following', () => {
    expect(startAction({ ...live, following: true, run: null })).toBe('start');
  });
});

describe('asking before a recording is thrown away', () => {
  const run = (ticks: number, samples: number) => ({
    dt: 0.001,
    outputFramerate: 60,
    capture: { frameCount: ticks },
    recording: { samples: { length: samples } },
  });

  it('measures the longer of the capture and the sampled trajectory', () => {
    expect(recordingSeconds(run(3000, 60))).toBeCloseTo(3);
    // A capture that filled its budget long ago still leaves the trajectory to lose.
    expect(recordingSeconds(run(2000, 600))).toBeCloseTo(10);
  });

  it('asks only past about five seconds, and never with no run', () => {
    expect(DISCARD_ASK_SECONDS).toBe(5);
    expect(asksBeforeDiscarding(null)).toBe(false);
    expect(asksBeforeDiscarding(run(4000, 240))).toBe(false);
    expect(asksBeforeDiscarding(run(5000, 300))).toBe(false);
    expect(asksBeforeDiscarding(run(5100, 306))).toBe(true);
  });

  it('says what goes, how much of it, and how to keep it', () => {
    expect(discardQuestion('Reset', 12.34)).toBe(
      "Reset throws away this run's 12.3 s recording. Export it first to keep it. Throw it away?",
    );
  });
});
