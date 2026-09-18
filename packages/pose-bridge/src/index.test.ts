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
  PoseBridgeWriter,
  bridgeBytes,
  readBridge,
  readGrabSlot,
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
    const writer = PoseBridgeWriter.open(rest, { path: join(dir, 'pose'), slots: 3 });
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
    const writer = PoseBridgeWriter.open(rest, { path: join(dir, 'pose'), slots: 3 });
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
      PoseBridgeWriter.open({ ...rest, position: [0, 0, 0] }, { path: join(dir, 'pose') }),
    ).toThrow(/positions/);
    expect(() =>
      PoseBridgeWriter.open({ ...rest, bones: [] }, { path: join(dir, 'pose') }),
    ).toThrow(/at least one bone/);
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
    };
    slot(0, 4n, 1, 17); // complete: squeezing, holding bone 17
    slot(1, 3n, 1, 5); // odd: caught mid-write, must not be trusted

    const left = readGrabSlot(bytes, 0);
    expect(left?.active).toBe(true);
    expect(left?.bone).toBe(17);
    expect(left?.point[1]).toBeCloseTo(1.2, 6);
    expect(left?.target[2]).toBeCloseTo(-0.35, 6);
    expect(left?.strength).toBe(1);
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
});
