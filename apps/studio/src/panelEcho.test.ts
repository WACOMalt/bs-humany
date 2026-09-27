/**
 * The headset's commands, echoed a gesture at a time: a drag said once when it starts and once,
 * with its count, when it ends; anything else said as it comes.
 */

import type { PanelCommand } from '@bs-humany/pose-bridge/codec';
import { describe, expect, it } from 'vitest';
import { PanelEcho } from './panelEcho.js';

const echoed = (command: PanelCommand) => ({ line: JSON.stringify(command), command });
const drive = (value: number) => echoed({ kind: 'drive', group: 3, value });

describe('PanelEcho', () => {
  it('says a drag when it starts and when it ends, and everything else as it comes', () => {
    const traced: string[] = [];
    const echo = new PanelEcho((message) => traced.push(message));
    echo.batch([drive(10), drive(20), drive(30)]);
    expect(traced).toEqual(['VR panel: {"kind":"drive","group":3,"value":10}']);
    echo.batch([drive(40)]);
    expect(traced).toHaveLength(1);
    echo.batch([]);
    echo.batch([echoed({ kind: 'set', key: 'grabStrength', value: 5 })]);
    echo.batch([echoed({ kind: 'pause' })]);
    expect(traced).toEqual([
      'VR panel: {"kind":"drive","group":3,"value":10}',
      'VR panel: {"kind":"drive","group":3,"value":40} (and 3 more)',
      'VR panel: {"kind":"set","key":"grabStrength","value":5}',
      'VR panel: {"kind":"pause"}',
    ]);
  });

  it('ends a drag when another target is moved, and says a new drag of the first at once', () => {
    const traced: string[] = [];
    const echo = new PanelEcho((message) => traced.push(message));
    echo.batch([
      drive(10),
      drive(20),
      echoed({ kind: 'drive', group: 4, value: 1 }),
      echoed({ kind: 'set', key: 'stature', value: 1.7 }),
      echoed({ kind: 'set', key: 'mass', value: 70 }),
    ]);
    echo.batch([drive(50)]);
    expect(traced).toEqual([
      'VR panel: {"kind":"drive","group":3,"value":10}',
      'VR panel: {"kind":"drive","group":3,"value":20} (and 1 more)',
      'VR panel: {"kind":"drive","group":4,"value":1}',
      'VR panel: {"kind":"set","key":"stature","value":1.7}',
      'VR panel: {"kind":"set","key":"mass","value":70}',
      'VR panel: {"kind":"drive","group":3,"value":50}',
    ]);
  });
});
