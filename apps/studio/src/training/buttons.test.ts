/**
 * The Brain tab's buttons, and what the tab says, from the one function both panels read.
 *
 * The desktop used to work its buttons out in four places and the headset worked them out again
 * in Rust from a handful of flags, with its own idea of what "no server" meant. The two drifted:
 * Hand over was refused on both whenever the dashboard was not running, although the studio has
 * held its own checkpoints, and shipped others, for as long as it has trained without one. These
 * pin the rules where they now live, so the next change to them is a change to one place.
 */

import { describe, expect, it } from 'vitest';
import {
  type BrainButtonInputs,
  brainButtons,
  policyNote,
  spineNote,
  stretchLabel,
} from './buttons.js';

const idle: BrainButtonInputs = {
  serverUp: false,
  localRun: false,
  localStopping: false,
  trainingRunning: false,
  trainingStoppable: false,
  elsewhere: false,
  selected: '',
  handingOver: false,
  policySet: false,
  nameOk: true,
};

describe('the Brain tab buttons', () => {
  it('offers Start and not Stop with no server and nothing training here', () => {
    const b = brainButtons(idle);
    expect(b.canStart).toBe(true);
    expect(b.canStop).toBe(false);
  });

  it('offers Stop and not Start while a run goes in this window, until it is asked to stop', () => {
    const running = brainButtons({ ...idle, localRun: true });
    expect(running.canStart).toBe(false);
    expect(running.canStop).toBe(true);
    // A generation has to finish before the run does; a second press would do nothing.
    expect(brainButtons({ ...idle, localRun: true, localStopping: true }).canStop).toBe(false);
    // The server's view of the world does not change who can stop a run in this window.
    expect(brainButtons({ ...idle, serverUp: true, localRun: true }).canStop).toBe(true);
  });

  it('refuses Start with a server that is training, or a trainer somebody started elsewhere', () => {
    expect(brainButtons({ ...idle, serverUp: true }).canStart).toBe(true);
    expect(brainButtons({ ...idle, serverUp: true, trainingRunning: true }).canStart).toBe(false);
    expect(brainButtons({ ...idle, serverUp: true, elsewhere: true }).canStart).toBe(false);
  });

  it('refuses Start for a name Start would refuse, on both paths, and nothing else', () => {
    // The window's own run and the server's alike: a name that is not one, or one taken, trained
    // a checkpoint nobody asked for on the path that did not check it.
    expect(brainButtons({ ...idle, nameOk: false }).canStart).toBe(false);
    expect(brainButtons({ ...idle, serverUp: true, nameOk: false }).canStart).toBe(false);
    // The name has nothing to do with stopping a run or handing a policy over.
    const running = brainButtons({ ...idle, localRun: true, selected: 'stand', nameOk: false });
    expect(running.canStop).toBe(true);
    expect(running.canHandOver).toBe(true);
  });

  it('offers Stop with a server while only the showcase is still up', () => {
    const b = brainButtons({ ...idle, serverUp: true, trainingStoppable: true });
    expect(b.canStop).toBe(true);
    // Stoppable is the server's word, and without a server there is nobody to ask.
    expect(brainButtons({ ...idle, trainingStoppable: true }).canStop).toBe(false);
  });

  it('offers Hand over for any selection, server or not, and while a policy is already in', () => {
    expect(brainButtons(idle).canHandOver).toBe(false);
    expect(brainButtons({ ...idle, selected: 'stand' }).canHandOver).toBe(true);
    expect(
      brainButtons({ ...idle, serverUp: true, selected: 'policies/stand.json' }).canHandOver,
    ).toBe(true);
    // Swapping one policy for another is a handover like the first.
    expect(brainButtons({ ...idle, selected: 'stand', policySet: true }).canHandOver).toBe(true);
    // One at a time: a second press while the first is still loading loads nothing twice.
    expect(brainButtons({ ...idle, selected: 'stand', handingOver: true }).canHandOver).toBe(false);
  });

  it('offers Release exactly while a policy is set', () => {
    expect(brainButtons(idle).canRelease).toBe(false);
    expect(brainButtons({ ...idle, policySet: true }).canRelease).toBe(true);
  });
});

describe('the policy note', () => {
  it('counts what a server lists', () => {
    expect(policyNote({ serverUp: true, count: 1, filesOnDisk: false, lost: false })).toBe(
      '1 checkpoint on this machine.',
    );
    expect(policyNote({ serverUp: true, count: 3, filesOnDisk: true, lost: false })).toBe(
      '3 checkpoints on this machine.',
    );
  });

  it('says where a studio with no server keeps what it trains, and sends nobody to a terminal', () => {
    const binary = policyNote({ serverUp: false, count: 2, filesOnDisk: true, lost: false });
    const tab = policyNote({ serverUp: false, count: 2, filesOnDisk: false, lost: false });
    expect(binary).toContain('checkpoints trained here are files in the data folder');
    expect(tab).toContain('kept in this browser');
    for (const note of [binary, tab]) expect(note).not.toContain('train:dashboard');
  });

  it('says so when the chosen checkpoint has gone from the list', () => {
    expect(policyNote({ serverUp: false, count: 2, filesOnDisk: true, lost: true })).toContain(
      'The chosen checkpoint is not in this list any more.',
    );
  });
});

describe('the Spine words', () => {
  it('reads off only when neither stretch nor damping does anything', () => {
    expect(stretchLabel(0, 0)).toBe('off');
    // Damping on its own is a cord: it answers the speed of a stretch.
    expect(stretchLabel(0, 0.25)).toBe('0.00');
    expect(stretchLabel(3.5, 0)).toBe('3.50');
  });

  it('points at the measurement rather than copying its table', () => {
    const off = spineNote({ stretch: 0, velocity: 0 });
    const on = spineNote({ stretch: 3.5, velocity: 0.25 });
    expect(off).toContain('no reflexes at all');
    expect(on).not.toContain('no reflexes at all');
    for (const note of [off, on]) expect(note).toContain('docs/validation/reflex-gains.md');
  });
});
