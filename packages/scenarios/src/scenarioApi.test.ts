/**
 * The script API the three runners share, over fakes.
 *
 * What is pinned is what the runners relied on when each wrote the object out by hand: segments
 * found by id, positions read live from the solver's storage, a missing hand or muscle set
 * ignored rather than refused, and the scenery kept in step with the solver -- with the studio's
 * short-circuit only where it is asked for, so the goldens and the trainer still pass every move.
 */

import type { StaticBox } from '@bs-humany/compiler';
import { type Quat, type Vec3, vec3 } from '@bs-humany/frames';
import { describe, expect, it } from 'vitest';
import { createScenarioApi } from './index.js';

const LEVEL: Quat = { x: 0, y: 0, z: 0, w: 1 };
const TILTED: Quat = { x: Math.sin(0.05), y: 0, z: 0, w: Math.cos(0.05) };

function platform(): StaticBox {
  return { id: 'platform', halfExtents: vec3(1, 0.05, 1), position: vec3(0, 0, 0), movable: true };
}

function recorder() {
  const moves: { id: string; position: Vec3; rotation: Quat }[] = [];
  return {
    moves,
    moveStaticBox: (id: string, position: Vec3, rotation: Quat) =>
      moves.push({ id, position, rotation }),
  };
}

describe('createScenarioApi', () => {
  it('finds segments by id, in index order, and -1 for one the body lacks', () => {
    const api = createScenarioApi({
      segmentIds: ['pelvis', 'head'],
      position: new Float64Array(6),
      moveStaticBox: () => {},
    });
    expect(api.segment('pelvis')).toBe(0);
    expect(api.segment('head')).toBe(1);
    expect(api.segment('tail')).toBe(-1);
  });

  it('reads positions from the storage at each call, not from a copy', () => {
    const position = new Float64Array(6);
    const api = createScenarioApi({
      segmentIds: ['pelvis', 'head'],
      position,
      moveStaticBox: () => {},
    });
    position.set([0.1, 1.6, -0.2], 3);
    expect(api.segmentPosition(1)).toEqual(vec3(0.1, 1.6, -0.2));
    position[4] = 1.5;
    expect(api.segmentPosition(1).y).toBe(1.5);
    // A segment the body lacks reads as the origin, as the runners always answered.
    expect(api.segmentPosition(api.segment('tail'))).toEqual(vec3(0, 0, 0));
  });

  it('passes grabs to the hand it was given', () => {
    const calls: string[] = [];
    const api = createScenarioApi({
      segmentIds: ['hand_r'],
      position: new Float64Array(3),
      grab: {
        grab: (s, local, target) => calls.push(`grab ${s} ${local.x} ${target.y}`),
        moveTo: (target) => calls.push(`move ${target.z}`),
        release: () => calls.push('release'),
      },
      moveStaticBox: () => {},
    });
    api.grab(0, vec3(0.5, 0, 0), vec3(0, 1.2, 0));
    api.moveGrab(vec3(0, 0, 0.3));
    api.release();
    expect(calls).toEqual(['grab 0 0.5 1.2', 'move 0.3', 'release']);
  });

  it('ignores grabs when there is no hand', () => {
    const api = createScenarioApi({
      segmentIds: ['hand_r'],
      position: new Float64Array(3),
      moveStaticBox: () => {},
    });
    expect(() => {
      api.grab(0, vec3(0, 0, 0), vec3(0, 1, 0));
      api.moveGrab(vec3(0, 1, 0));
      api.release();
    }).not.toThrow();
  });

  it('passes every move through, the same pose twice too, without scenery', () => {
    const solver = recorder();
    const api = createScenarioApi({ segmentIds: [], position: new Float64Array(0), ...solver });
    api.moveStaticBox('platform', vec3(0, 0.1, 0), TILTED);
    api.moveStaticBox('platform', vec3(0, 0.1, 0), TILTED);
    api.moveStaticBox('elsewhere', vec3(0, 0, 0), LEVEL);
    expect(solver.moves.map((m) => m.id)).toEqual(['platform', 'platform', 'elsewhere']);
  });

  it('keeps the scenery where the solver has it, with copies of what the script passed', () => {
    const solver = recorder();
    const boxes = [platform()];
    const api = createScenarioApi({
      segmentIds: [],
      position: new Float64Array(0),
      ...solver,
      scenery: { boxes },
    });
    const at = { x: 0, y: 0.1, z: 0 };
    api.moveStaticBox('platform', at, TILTED);
    // Without the short-circuit the same pose goes through again, and an unknown box reaches the
    // solver, which is where the goldens and the trainer have always had it refused.
    api.moveStaticBox('platform', at, TILTED);
    api.moveStaticBox('elsewhere', vec3(0, 0, 0), LEVEL);
    expect(solver.moves.map((m) => m.id)).toEqual(['platform', 'platform', 'elsewhere']);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.position).toEqual(vec3(0, 0.1, 0));
    expect(boxes[0]?.rotation).toEqual(TILTED);
    expect(boxes[0]?.halfExtents).toEqual(vec3(1, 0.05, 1));
    expect(boxes[0]?.movable).toBe(true);
    at.y = 9;
    expect(boxes[0]?.position.y).toBe(0.1);
  });

  it('skips a move that changes nothing, and a box it does not have, when asked to', () => {
    const solver = recorder();
    const boxes = [platform()];
    const api = createScenarioApi({
      segmentIds: [],
      position: new Float64Array(0),
      ...solver,
      scenery: { boxes, skipUnchanged: true },
    });
    // Declared with no rotation, so the first move goes through even to where it already is.
    api.moveStaticBox('platform', vec3(0, 0, 0), LEVEL);
    api.moveStaticBox('platform', vec3(0, 0, 0), LEVEL);
    api.moveStaticBox('platform', vec3(0, 0, 0), TILTED);
    api.moveStaticBox('elsewhere', vec3(0, 0, 0), LEVEL);
    expect(solver.moves.map((m) => m.rotation)).toEqual([LEVEL, TILTED]);
    expect(boxes[0]?.rotation).toEqual(TILTED);
  });
});
