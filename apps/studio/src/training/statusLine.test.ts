/**
 * The line under the Brain tab's Start and Stop, and which run's brain the Activity panel reads.
 *
 * Both used to be worked out inline in `brain.ts`, and both were wrong in ways a person could not
 * see past: a trainer that died on start left the line saying "Not training. Last run: ..." about a
 * run that was not the one just started, and the activity poll went on reading the file of a run
 * that had ended for as long as the tab was open. These pin what the line says in each state the
 * dashboard can report, and whose file is read.
 */

import { describe, expect, it } from 'vitest';
import {
  type TrainingStatus,
  activitySource,
  progressPhrase,
  runLabel,
  trainingStatusLine,
} from './statusLine.js';

const latest = (over: Partial<NonNullable<TrainingStatus['latest']>> = {}) => ({
  name: 'stand',
  updated: '2026-09-27T10:00:00.000Z',
  episodes: 1200,
  best: { fitness: 3.94, alive: 2.1, generation: 40 },
  profile: 'L2_standard',
  generation: 42,
  generations: 42,
  series: [],
  ...over,
});

const status = (over: Partial<TrainingStatus> = {}): TrainingStatus => ({
  running: false,
  showcase: false,
  elsewhere: false,
  startedAt: null,
  task: null,
  name: null,
  exit: null,
  latest: null,
  ...over,
});

describe('trainingStatusLine', () => {
  it('names a running checkpoint and its task when they differ', () => {
    const line = trainingStatusLine(
      status({ running: true, name: 'stand-cord', task: 'stand', latest: latest() }),
    );
    expect(line.startsWith('Training stand-cord (stand): ')).toBe(true);
  });

  it('does not repeat the task when the checkpoint is named for it', () => {
    const line = trainingStatusLine(
      status({ running: true, name: 'stand', task: 'stand', latest: latest() }),
    );
    expect(line.startsWith('Training stand: generation 42')).toBe(true);
  });

  it('says how far along a run is and about how long is left', () => {
    const line = trainingStatusLine(
      status({
        running: true,
        name: 'stand',
        task: 'stand',
        latest: latest({ target: 600, secondsPerGeneration: 20, state: 'running' }),
      }),
    );
    // 558 generations at 20 s is 186 minutes.
    expect(line).toContain('generation 42 of 600, about 3 h 6 m left');
    expect(line).toContain('record 3.94 (2.10 s up) at generation 40');
  });

  it('names the checkout a dashboard trains through', () => {
    const line = trainingStatusLine(
      status({
        running: true,
        name: 'stand',
        task: 'stand',
        latest: latest(),
        checkout: { root: '/home/x/bs-humany-module-muscley/', branch: 'main', commit: 'c77c40a' },
      }),
    );
    expect(line).toContain('training through main@c77c40a (bs-humany-module-muscley)');
  });

  it('says why a trainer stopped when it stopped with an error', () => {
    const line = trainingStatusLine(
      status({ exit: 1, error: "train-nerves: No scenario 'nope'", name: 'probe', task: 'stand' }),
    );
    expect(
      line.startsWith("Training stopped with an error: train-nerves: No scenario 'nope'."),
    ).toBe(true);
    expect(line).toContain("The dashboard's terminal has the full message.");
  });

  it('keeps the error ahead of a showcase that is still playing', () => {
    const line = trainingStatusLine(
      status({ exit: 'SIGKILL', error: 'was killed by SIGKILL', showcase: true, latest: latest() }),
    );
    expect(line.startsWith('Training stopped with an error: was killed by SIGKILL.')).toBe(true);
    expect(line).toContain('the showcase is still playing the run');
  });

  it('names the last run by its checkpoint when nothing is training', () => {
    const line = trainingStatusLine(status({ exit: 0, latest: latest({ name: 'stand' }) }));
    expect(line.startsWith('Not training. Last run of stand: generation 42')).toBe(true);
  });

  it('says a last run finished, or stopped short of its target', () => {
    expect(
      trainingStatusLine(
        status({ latest: latest({ generation: 600, target: 600, state: 'finished' }) }),
      ),
    ).toContain('generation 600 of 600, finished');
    expect(
      trainingStatusLine(status({ latest: latest({ target: 600, state: 'stopped' }) })),
    ).toContain('generation 42 of 600, stopped');
  });

  it('says only that nothing is training when there is no record of any run', () => {
    expect(trainingStatusLine(status())).toBe('Not training.');
  });

  it('reads an older dashboard, which counts rows and sends no progress', () => {
    // No name and no last generation: an older dashboard sent the number of rows as `generations`.
    const { name: _name, generation: _generation, ...old } = latest({ generations: 17 });
    expect(trainingStatusLine(status({ running: true, task: 'stand', latest: old }))).toBe(
      'Training stand: generation 17, record 3.94 (2.10 s up) at generation 40.',
    );
    expect(trainingStatusLine(status({ task: 'stand', latest: old }))).toBe(
      'Not training. Last run: generation 17, record 3.94 (2.10 s up) at generation 40.',
    );
  });

  it('sends a trainer started from a terminal back to the terminal', () => {
    expect(trainingStatusLine(status({ elsewhere: true, latest: latest() }))).toBe(
      'A trainer started from a terminal is running; stop it there.',
    );
  });

  it("says what a terminal's trainer is training when its record says it is going", () => {
    const going = latest({ name: 'foo', target: 600, secondsPerGeneration: 60, state: 'running' });
    expect(trainingStatusLine(status({ elsewhere: true, latest: going }))).toBe(
      'A trainer started from a terminal is training foo: generation 42 of 600, about 9 h 18 m left, ' +
        'record 3.94 (2.10 s up) at generation 40; stop it there.',
    );
  });

  it('says there is no record rather than printing a score nobody reached', () => {
    const line = trainingStatusLine(
      status({
        running: true,
        name: 'stand',
        task: 'stand',
        // JSON turns minus infinity into null, which is what a run with no record yet sends.
        latest: latest({ best: { fitness: null as unknown as number, alive: 0, generation: 0 } }),
      }),
    );
    expect(line).toContain('no record yet');
  });
});

describe('progressPhrase', () => {
  it('is the plain generation without a target', () => {
    expect(progressPhrase({ generation: 5 })).toBe('generation 5');
  });
  it('leaves out what is left until the pace is known', () => {
    expect(progressPhrase({ generation: 1, target: 10, secondsPerGeneration: 0 })).toBe(
      'generation 1 of 10',
    );
  });
  it('says less than a minute rather than nothing', () => {
    expect(
      progressPhrase({ generation: 9, target: 10, secondsPerGeneration: 5, state: 'running' }),
    ).toBe('generation 9 of 10, about < 1 m left');
  });
});

describe('runLabel', () => {
  it('shows the task beside a checkpoint named otherwise', () => {
    expect(runLabel('stand-cord', 'stand')).toBe('stand-cord (stand)');
    expect(runLabel('stand', 'stand')).toBe('stand');
    expect(runLabel(undefined, 'balance')).toBe('balance');
  });
});

describe('activitySource', () => {
  it("reads the server's run while it trains or its showcase plays", () => {
    expect(activitySource(status({ running: true, name: 'mine' }), 'bridge')).toBe('mine');
    expect(activitySource(status({ showcase: true, name: 'mine' }), 'bridge')).toBe('mine');
  });
  it('reads whoever is on the bridge once the server run has ended', () => {
    // The dashboard keeps the last run's name after it ends, so a showcase started later from a
    // terminal would otherwise never be drawn.
    expect(activitySource(status({ name: 'mine', exit: 0 }), 'bridge')).toBe('bridge');
    expect(activitySource(undefined, 'bridge')).toBe('bridge');
  });
  it('reads nothing when nobody is playing a run', () => {
    expect(activitySource(status({ name: 'mine' }), undefined)).toBeUndefined();
    expect(activitySource(undefined, undefined)).toBeUndefined();
  });
});
