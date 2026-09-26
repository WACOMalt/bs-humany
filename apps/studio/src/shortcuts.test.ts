/**
 * Which keys a focused control keeps, and which go through to the studio's shortcuts.
 *
 * Plain strings in, no DOM: the rule is what the platform does with a key on each kind of
 * control, and a focused control must keep exactly those keys and give up the rest.
 */

import { describe, expect, it } from 'vitest';
import { keyOwnedByControl, keyOwnedByTarget } from './shortcuts.js';

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
