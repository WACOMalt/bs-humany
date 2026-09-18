/**
 * The bridge file, read back the way a reader would read it.
 *
 * What matters is the seqlock: that a completed slot reads as even, that `newest` points at the
 * slot just written, and that the writer goes round the ring rather than overwriting the slot a
 * reader is most likely holding. And that the bytes are where the layout says, which is what the
 * Rust side is going to depend on.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GRAB_BYTES,
  GRAB_MAGIC,
  GRAB_SLOT_BYTES,
  GrabIntentReader,
  HEADER_BYTES,
  NO_FRAME,
  bridgeBytes,
  openMuscleBridge,
  openPoseBridge,
  readBridge,
  readGrabSlot,
  readMuscleBridge,
  slotBytes,
  slotsOffset,
} from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pose-bridge-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rest = {
  bones: ['pelvis', 'femur_r', 'tibia_r'],
  position: [0, 0.9, 0, 0.1, 0.8, 0, 0.1, 0.4, 0],
  orientation: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  datasetScale: 1.7 / 1.6963,
};

describe('the pose bridge file', () => {
  it('is laid out where the header says, and starts with no frame', () => {
    const writer = openPoseBridge(rest, { path: join(dir, 'pose'), slots: 3 });
    writer.close();
    const bytes = readFileSync(join(dir, 'pose'));
    expect(bytes.length).toBe(bridgeBytes(3, 3));
    // Every region is cache-line aligned, so a reader never straddles one with a slot header.
    expect(slotsOffset(3) % 64).toBe(0);
    expect(slotBytes(3) % 64).toBe(0);
    expect(slotsOffset(3)).toBeGreaterThanOrEqual(HEADER_BYTES + 3 * 7 * 4);

    const read = readBridge(bytes);
    expect(read.bones).toBe(3);
    expect(read.slots).toBe(3);
    expect(read.newest).toBe(NO_FRAME);
    expect(read.published).toBe(0);
    expect(read.datasetScale).toBeCloseTo(rest.datasetScale, 12);
    // Single precision on the way in, so 0.9 comes back as the nearest f32 to it.
    rest.position.forEach((v, i) => expect(read.rest.position[i]).toBeCloseTo(v, 6));
    rest.orientation.forEach((v, i) => expect(read.rest.orientation[i]).toBeCloseTo(v, 6));
    // Untouched slots read as never written.
    expect(read.frame(0).seq).toBe(0);
    // And the sidecar names the bones in order.
    const sidecar = JSON.parse(readFileSync(join(dir, 'pose.json'), 'utf8')) as {
      bones: string[];
    };
    expect(sidecar.bones).toEqual(rest.bones);
  });

  it('publishes into the ring, even when complete, newest pointing at the last one', () => {
    const writer = openPoseBridge(rest, { path: join(dir, 'pose'), slots: 3 });
    const frame = (t: number) => ({
      position: [0, 0.9 - t * 0.01, 0, 0.1, 0.8, 0, 0.1, 0.4, t],
      orientation: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    });
    for (let t = 0; t < 5; t++) {
      const f = frame(t);
      writer.publish(t * 10, t * 0.01, f.position, f.orientation);
    }
    writer.close();
    const read = readBridge(readFileSync(join(dir, 'pose')));
    expect(read.published).toBe(5);
    // Five publishes round three slots: 0, 1, 2, 0, 1 -- so the newest is slot 1, and it holds
    // frame 4, and slot 0 holds frame 3, and slot 2 still holds frame 2.
    expect(read.newest).toBe(1);
    expect(read.frame(1).tick).toBe(40);
    expect(read.frame(0).tick).toBe(30);
    expect(read.frame(2).tick).toBe(20);
    for (const slot of [0, 1, 2]) {
      const f = read.frame(slot);
      // Complete slots are even and non-zero: that is what a reader checks before trusting one.
      expect(f.seq % 2).toBe(0);
      expect(f.seq).toBeGreaterThan(0);
    }
    // A slot written twice has a sequence of four: odd, even, odd, even.
    expect(read.frame(0).seq).toBe(4);
    expect(read.frame(2).seq).toBe(2);
    // And the body is the body: single precision of what was given.
    const f4 = read.frame(1);
    expect(f4.simTime).toBeCloseTo(0.04, 12);
    expect(f4.position[1]).toBeCloseTo(0.86, 5);
    expect(f4.position[8]).toBeCloseTo(4, 5);
    expect(writer.framesPublished).toBe(5);
  });

  it('refuses a rest pose whose arrays do not match its bones', () => {
    expect(() =>
      openPoseBridge({ ...rest, position: [0, 0, 0] }, { path: join(dir, 'pose') }),
    ).toThrow(/positions/);
    expect(() => openPoseBridge({ ...rest, bones: [] }, { path: join(dir, 'pose') })).toThrow(
      /at least one bone/,
    );
  });

  it('reads a grab intent the renderer wrote, and skips one mid-write', () => {
    // Built by hand at the documented offsets, which is what the Rust writer's test pins from its
    // side: if either drifts, one of the two stops matching this layout.
    const bytes = Buffer.alloc(GRAB_BYTES);
    bytes.writeUInt32LE(GRAB_MAGIC, 0);
    bytes.writeUInt32LE(1, 4);
    bytes.writeUInt32LE(2, 8);
    bytes.writeUInt32LE(GRAB_SLOT_BYTES, 12);
    bytes.writeBigUInt64LE(7n, 16);
    const slot = (hand: number, seq: bigint, active: number, bone: number) => {
      const base = HEADER_BYTES + hand * GRAB_SLOT_BYTES;
      bytes.writeBigUInt64LE(seq, base);
      bytes.writeUInt32LE(active, base + 8);
      bytes.writeInt32LE(bone, base + 12);
      bytes.writeFloatLE(0.1, base + 16);
      bytes.writeFloatLE(1.2, base + 20);
      bytes.writeFloatLE(-0.3, base + 24);
      bytes.writeFloatLE(0.15, base + 28);
      bytes.writeFloatLE(1.25, base + 32);
      bytes.writeFloatLE(-0.35, base + 36);
      bytes.writeFloatLE(1, base + 40);
      bytes.writeFloatLE(0, base + 44);
      bytes.writeFloatLE(0.6, base + 48);
      bytes.writeFloatLE(0, base + 52);
      bytes.writeFloatLE(0.8, base + 56);
    };
    slot(0, 4n, 1, 17); // complete: squeezing, holding bone 17
    slot(1, 3n, 1, 5); // odd: caught mid-write, must not be trusted

    const left = readGrabSlot(bytes, 0);
    expect(left?.active).toBe(true);
    expect(left?.bone).toBe(17);
    expect(left?.point[1]).toBeCloseTo(1.2, 6);
    expect(left?.target[2]).toBeCloseTo(-0.35, 6);
    expect(left?.strength).toBe(1);
    expect(left?.rotation[1]).toBeCloseTo(0.6, 6);
    expect(left?.rotation[3]).toBeCloseTo(0.8, 6);
    expect(readGrabSlot(bytes, 1)).toBeUndefined();

    // And through the reader, from a file, which is how the simulation gets it.
    writeFileSync(join(dir, 'grab'), bytes);
    const reader = GrabIntentReader.open(join(dir, 'grab')) as GrabIntentReader;
    expect(reader).toBeDefined();
    const [l, r] = reader.read();
    expect(l?.bone).toBe(17);
    expect(r).toBeUndefined();
    reader.close();
    // No file yet is not an error: the renderer may simply not have started.
    expect(GrabIntentReader.open(join(dir, 'absent'))).toBeUndefined();
  });

  it('carries muscle rings round their own ring, the same shape the fixture pins', () => {
    // Two bellies of three rings, four segments round; five frames into three slots -- and these
    // are the numbers `generate-pose-bridge-fixture` writes for the Rust reader to check.
    const shape = { units: 2, rings: 3, segments: 4 };
    const writer = openMuscleBridge(shape, { path: join(dir, 'muscles'), slots: 3 });
    for (let t = 0; t < 5; t++) writer.publish(t * 10, ...muscleFrame(t));
    writer.close();
    const read = readMuscleBridge(readFileSync(join(dir, 'muscles')));
    expect(read.shape).toEqual(shape);
    expect(read.slots).toBe(3);
    expect(read.published).toBe(5);
    expect(read.newest).toBe(1);
    const f4 = read.frame(1);
    expect(f4.tick).toBe(40);
    expect(f4.seq).toBe(4);
    // Unit 1, ring 2 is ring 5: its centre y is 1 + 2/2 + 0.04, its radius 0.05 + 0.004.
    expect(f4.position[5 * 3 + 1]).toBeCloseTo(2.04, 5);
    expect(f4.radius[5]).toBeCloseTo(0.054, 5);
    expect(f4.orientation[5 * 4 + 3]).toBe(1);
    expect(() => writer.publish(0, [], [], [])).toThrow(/rings/);
  });
});

/** The frames the muscle fixture holds: ring r of unit u at y = u + r/2, growing a little a frame. */
function muscleFrame(t: number): [number[], number[], number[]] {
  const position: number[] = [];
  const orientation: number[] = [];
  const radius: number[] = [];
  for (let u = 0; u < 2; u++) {
    for (let r = 0; r < 3; r++) {
      position.push(0.1 * u, u + r / 2 + 0.01 * t, 0);
      orientation.push(0, 0, 0, 1);
      radius.push(0.05 + 0.001 * t);
    }
  }
  return [position, orientation, radius];
}
