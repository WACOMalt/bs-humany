import { describe, expect, it } from 'vitest';
import {
  BoneCapture,
  CAPTURE_BUDGET_BYTES,
  MIN_CAPTURE_BUDGET_BYTES,
  captureCeilingBytes,
  defaultCaptureBudgetBytes,
} from './capture.js';

import { buildAnimatedGlb, readGlb } from './glb.js';

const BONES = 3;

/** A frame whose numbers identify the tick it came from, so a duplicate is visible. */
function frame(tick: number) {
  const position = new Float64Array(BONES * 3);
  const orientation = new Float64Array(BONES * 4);
  for (let b = 0; b < BONES; b++) {
    position[3 * b] = tick;
    position[3 * b + 1] = b;
    orientation[4 * b + 3] = 1;
  }
  return { position, orientation };
}

/** The tick each captured frame came from, read back out of the positions. */
function ticksIn(capture: BoneCapture): number[] {
  const view = capture.view();
  const out: number[] = [];
  for (let f = 0; f < view.frames; f++) out.push(view.position[f * view.bones * 3] ?? Number.NaN);
  return out;
}

describe('BoneCapture', () => {
  it('keeps exactly one frame per tick, in order, with none repeated', () => {
    const capture = new BoneCapture();
    for (let tick = 1; tick <= 1000; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    const ticks = ticksIn(capture);
    expect(capture.frameCount).toBe(1000);
    expect(ticks).toHaveLength(1000);
    expect(new Set(ticks).size).toBe(1000);
    expect(ticks[0]).toBe(1);
    expect(ticks[999]).toBe(1000);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBe((ticks[i - 1] ?? 0) + 1);
  });

  it('overwrites rather than forks when the timeline is rewound and replayed', () => {
    const capture = new BoneCapture();
    for (let tick = 1; tick <= 500; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    // Scrub back to tick 300 and run forward again, as the studio's timeline does.
    capture.truncate(300);
    expect(capture.frameCount).toBe(300);
    for (let tick = 301; tick <= 600; tick++) {
      const f = frame(tick + 10_000);
      capture.append(tick, f.position, f.orientation);
    }
    const ticks = ticksIn(capture);
    expect(ticks).toHaveLength(600);
    expect(new Set(ticks).size).toBe(600);
    // The replayed stretch holds the new run's frames, not the old ones kept alongside.
    expect(ticks[299]).toBe(300);
    expect(ticks[300]).toBe(10_301);
  });

  it('starts over rather than leaving a hole when a tick does not follow the last', () => {
    const capture = new BoneCapture();
    for (let tick = 1; tick <= 20; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    const jumped = frame(500);
    capture.append(500, jumped.position, jumped.orientation);
    const view = capture.view();
    expect(view.frames).toBe(1);
    expect(view.firstTick).toBe(500);
  });

  it('clears on a restore, so a restored run does not inherit the old one', () => {
    const capture = new BoneCapture();
    for (let tick = 1; tick <= 40; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    capture.clear();
    expect(capture.frameCount).toBe(0);
    const f = frame(7);
    capture.append(7, f.position, f.orientation);
    expect(capture.view().firstTick).toBe(7);
    expect(capture.frameCount).toBe(1);
  });

  it('stops at its budget and says so, keeping what it already had', () => {
    const perFrame = BONES * 7 * 4;
    const room = 40;
    const capture = new BoneCapture(perFrame * room);
    for (let tick = 1; tick <= room + 50; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    expect(capture.full).toBe(true);
    // The frames it already had survive: a full capture holds the start of the run, and the
    // fifty ticks it refused do not take the first forty with them.
    expect(capture.frameCount).toBe(room);
    const ticks = ticksIn(capture);
    expect(ticks).toHaveLength(room);
    expect(ticks[0]).toBe(1);
    expect(ticks[room - 1]).toBe(room);
    expect(new Set(ticks).size).toBe(ticks.length);
    // The default budget is the one the studio runs with; a minute at 500 Hz fits comfortably.
    expect(CAPTURE_BUDGET_BYTES).toBeGreaterThan(206 * 28 * 500 * 60);
  });

  it('takes frames again when the budget is raised, and stops when it is lowered', () => {
    const perFrame = BONES * 28;
    const capture = new BoneCapture(perFrame * 10);
    for (let tick = 1; tick <= 40; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    expect(capture.full).toBe(true);
    expect(capture.frameCount).toBe(10);

    // Raised and resumed on the very next tick, so the frames stay contiguous and the ten it
    // already had are still at the front. This is the case the panel asks for by pausing first.
    capture.setBudget(perFrame * 30);
    expect(capture.full).toBe(false);
    for (let tick = 11; tick <= 25; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    expect(capture.frameCount).toBe(25);
    expect(ticksIn(capture)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));

    // Lowered below what is held: it stops, and nothing already taken is thrown away.
    capture.setBudget(perFrame * 12);
    expect(capture.full).toBe(true);
    expect(capture.frameCount).toBe(25);
    const f = frame(26);
    capture.append(26, f.position, f.orientation);
    expect(capture.frameCount).toBe(25);
  });

  it('sizes its default budget from what the machine will admit to', () => {
    // Neither `performance.memory` nor `navigator.deviceMemory` exists under Node, which is the
    // fallback path: four gigabytes assumed, two thirds of it taken, and never below the floor.
    const ceiling = captureCeilingBytes();
    expect(ceiling).toBeGreaterThanOrEqual(MIN_CAPTURE_BUDGET_BYTES);
    expect(defaultCaptureBudgetBytes()).toBe(
      Math.max(MIN_CAPTURE_BUDGET_BYTES, Math.floor((ceiling * 2) / 3)),
    );
    expect(defaultCaptureBudgetBytes()).toBeLessThanOrEqual(ceiling);
  });

  it('exports keyframe times that are unique and strictly increasing', () => {
    const capture = new BoneCapture();
    for (let tick = 1; tick <= 250; tick++) {
      const f = frame(tick);
      capture.append(tick, f.position, f.orientation);
    }
    const view = capture.view();
    const rate = 1000;
    const times = Float64Array.from({ length: view.frames }, (_, f) => f / rate);
    const glb = buildAnimatedGlb({
      nodes: Array.from({ length: BONES }, (_, i) => ({
        id: `bone${i}`,
        parent: -1,
        restWorld: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      })),
      animation: { times, position: view.position, orientation: view.orientation },
    });
    const { json, binary } = readGlb(glb);
    const accessors = json.accessors as { bufferView: number; count: number }[];
    const views = json.bufferViews as { byteOffset: number; byteLength: number }[];
    const animation = (json.animations as { samplers: { input: number }[] }[])[0];
    const input = accessors[animation?.samplers[0]?.input ?? 0];
    const bufferView = views[input?.bufferView ?? 0];
    if (!input || !bufferView) throw new Error('no time accessor');
    const written = new Float32Array(
      binary.buffer,
      binary.byteOffset + bufferView.byteOffset,
      bufferView.byteLength / 4,
    );
    expect(input.count).toBe(view.frames);
    expect(new Set(written).size).toBe(view.frames);
    for (let i = 1; i < written.length; i++) {
      expect(written[i]).toBeGreaterThan(written[i - 1] ?? 0);
    }
  });
});
