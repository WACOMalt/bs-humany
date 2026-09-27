/**
 * Which keys a focused control keeps, and which go through to the studio's shortcuts.
 *
 * Plain strings in, no DOM: the rule is what the platform does with a key on each kind of
 * control, and a focused control must keep exactly those keys and give up the rest.
 */

import { describe, expect, it } from 'vitest';
import { keyOwnedByControl, keyOwnedByTarget } from './shortcuts.js';
import { tabKeyTarget } from './ui/tabs.js';

const owned = (tag: string, type: string | undefined, role: string | null, key: string) =>
  keyOwnedByControl(tag, type, role, false, key);

describe('keyOwnedByControl', () => {
  it('lets a button keep Space and Enter and give up the arrows', () => {
    expect(owned('button', undefined, null, ' ')).toBe(true);
    expect(owned('button', undefined, null, 'Enter')).toBe(true);
    expect(owned('button', undefined, null, 'ArrowRight')).toBe(false);
    expect(owned('button', undefined, null, '3')).toBe(false);
  });

  it('lets a checkbox keep Space and give up Home', () => {
    expect(owned('input', 'checkbox', null, ' ')).toBe(true);
    expect(owned('input', 'checkbox', null, 'Home')).toBe(false);
    expect(owned('input', 'checkbox', null, 'ArrowLeft')).toBe(false);
  });

  it('lets a slider and a text box keep everything', () => {
    expect(owned('input', 'range', null, 'ArrowLeft')).toBe(true);
    expect(owned('input', 'text', null, '1')).toBe(true);
    expect(owned('input', 'number', null, ' ')).toBe(true);
    expect(owned('textarea', undefined, null, '9')).toBe(true);
    expect(owned('select', undefined, null, 'ArrowDown')).toBe(true);
  });

  it('lets a radio button keep Space and the arrows', () => {
    expect(owned('input', 'radio', null, ' ')).toBe(true);
    expect(owned('input', 'radio', null, 'ArrowDown')).toBe(true);
    expect(owned('input', 'radio', null, 'Home')).toBe(false);
  });

  it('lets a splitter and a tab keep the arrows, Home and End', () => {
    expect(owned('div', undefined, 'separator', 'ArrowLeft')).toBe(true);
    expect(owned('button', undefined, 'tab', 'ArrowDown')).toBe(true);
    expect(owned('div', undefined, 'tab', 'End')).toBe(true);
    expect(owned('div', undefined, 'separator', ' ')).toBe(false);
  });

  it('lets the tab strip and the resizer keep every key they move by, and nothing else', () => {
    // The strip moves between tabs by the up and down arrows and jumps by Home and End; the
    // properties resizer moves by the left and right arrows. None of them may reach the timeline.
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(owned('button', undefined, 'tab', key)).toBe(true);
    }
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(owned('div', undefined, 'separator', key)).toBe(true);
    }
    // A tab is still a button: Space and Enter press it. The view numbers and F stay the studio's.
    expect(owned('button', undefined, 'tab', ' ')).toBe(true);
    expect(owned('button', undefined, 'tab', '1')).toBe(false);
    expect(owned('div', undefined, 'separator', 'f')).toBe(false);
  });

  it('gives everything up on anything else, and keeps everything when editable', () => {
    expect(owned('div', undefined, null, ' ')).toBe(false);
    expect(owned('canvas', undefined, null, 'ArrowRight')).toBe(false);
    expect(keyOwnedByControl('div', undefined, null, true, ' ')).toBe(true);
  });
});

describe('keyOwnedByTarget', () => {
  it('owns nothing when there is no element', () => {
    expect(keyOwnedByTarget(null, ' ')).toBe(false);
  });

  it('reads the tag, type and role off an element', () => {
    const checkbox = {
      tagName: 'INPUT',
      type: 'checkbox',
      isContentEditable: false,
      getAttribute: () => null,
    } as unknown as EventTarget;
    expect(keyOwnedByTarget(checkbox, ' ')).toBe(true);
    expect(keyOwnedByTarget(checkbox, 'ArrowRight')).toBe(false);
  });
});

// The other half of the tab strip's keys: what each one moves to, once the shortcuts have let it be.
describe('tabKeyTarget', () => {
  it('moves down and up the strip, wrapping at the ends', () => {
    expect(tabKeyTarget('ArrowDown', 0, 9)).toBe(1);
    expect(tabKeyTarget('ArrowDown', 8, 9)).toBe(0);
    expect(tabKeyTarget('ArrowUp', 0, 9)).toBe(8);
    expect(tabKeyTarget('ArrowUp', 4, 9)).toBe(3);
  });

  it('jumps to the ends with Home and End, and ignores every other key', () => {
    expect(tabKeyTarget('Home', 5, 9)).toBe(0);
    expect(tabKeyTarget('End', 2, 9)).toBe(8);
    expect(tabKeyTarget('ArrowLeft', 2, 9)).toBeUndefined();
    expect(tabKeyTarget(' ', 2, 9)).toBeUndefined();
    expect(tabKeyTarget('ArrowDown', 0, 0)).toBeUndefined();
  });
});
