/**
 * The pose bridge: how a simulation hands its body pose to a renderer it does not own.
 *
 * ADR-012 says what this has to be. A renderer draws at the display's rate from the newest pose it
 * has and never waits for a newer one; a simulation publishes at its own rate and never waits for
 * a renderer to collect. Latest-wins, non-blocking both ways, no queue. A pose superseded before
 * anybody read it is simply overwritten.
 *
 * ## The mechanism
 *
 * A file on tmpfs -- `/dev/shm` on Linux -- that this side writes with `fs.writeSync` at fixed
 * offsets and the other side maps read-only. tmpfs pages are shared, so a write here is visible
 * there without a copy; and a write syscall is an ordering point, so the seqlock below is sound
 * without atomics that Node does not have.
 *
 * Node has no mmap and does not need one: a pose frame is a few kilobytes and publishing it is
 * four small writes, at the output frame rate rather than every tick, because per ADR-012 a
 * renderer cannot use more than one pose per frame it draws.
 *
 * ## The layout, little-endian, all offsets in bytes
 *
 *   HEADER, 64 bytes
 *     0   u32  magic          0x50485342, "BSHP"
 *     4   u32  version        1
 *     8   u32  bones
 *     12  u32  slots
 *     16  u32  newest         index of the newest complete slot; NO_FRAME until one is
 *     20  u32  slotBytes
 *     24  f64  datasetScale   what the reader multiplies the mesh pack's vertices by
 *     32  u64  published      frames published so far; a reader that sees it stop knows why
 *
 *   REST, at 64: bones x (f32 position xyz, f32 orientation xyzw)     written once
 *
 *   SLOTS, after REST, `slots` of them, each `slotBytes`:
 *     0   u64  seq            odd while being written, even once complete, 0 never written
 *     8   u64  tick
 *     16  f64  simTime        seconds
 *     24  u64  writtenNs      the writer's monotonic clock; informational
 *     32       bones x (f32 position xyz, f32 orientation xyzw)
 *
 * A sidecar `<path>.json` names the bones in order, because names are variable length and are
 * read once.
 *
 * ## Why the rest transforms travel too
 *
 * The mesh pack is world-space vertices at its own subject's stature. A bone's vertex at time t
 * is `current(t) * rest^-1 * (vertex * datasetScale)`, which is exactly the skin the studio
 * draws. The reader therefore needs `rest` and `datasetScale` as well as `current`, and both are
 * constants of the run, so they are written once at the front rather than once a frame.
 *
 * ## The seqlock
 *
 * The writer sets a slot's `seq` odd, writes the body, sets `seq` even, then publishes the slot
 * as `newest`. A reader takes `newest`, reads `seq` (must be even and non-zero), copies the body,
 * and reads `seq` again; if it changed, the copy straddled a write and is discarded. With three
 * slots and a writer that goes round in order, a reader holding one is two writes from being
 * disturbed, which at the rates involved is never.
 */

import { closeSync, ftruncateSync, openSync, writeFileSync, writeSync } from 'node:fs';

export const POSE_BRIDGE_MAGIC = 0x50485342;
export const POSE_BRIDGE_VERSION = 1;
export const HEADER_BYTES = 64;
export const FLOATS_PER_BONE = 7;
export const SLOT_HEADER_BYTES = 32;
/** `newest` before any frame has been published. */
export const NO_FRAME = 0xffffffff;
/** Where the bridge lives when nobody says otherwise. */
export const DEFAULT_PATH = '/dev/shm/bs-humany-pose';

export interface PoseBridgeOptions {
  /** The file to write. tmpfs is the point; anywhere else works and is merely slower. */
  readonly path?: string;
  /** Ring slots. Three is the classic answer and the least that never disturbs a reader. */
  readonly slots?: number;
  /**
   * The monotonic clock stamped into each frame, nanoseconds. Injectable so a fixture can be
   * written byte-for-byte the same twice, which is what lets a `--check` gate exist for it.
   */
  readonly clock?: () => bigint;
}

export interface RestPose {
  /** Bone ids in the order every frame's arrays follow. */
  readonly bones: readonly string[];
  /** `bones.length * 3` rest world positions and `bones.length * 4` rest world orientations. */
  readonly position: ArrayLike<number>;
  readonly orientation: ArrayLike<number>;
  /** stature / the pack's subject stature. */
  readonly datasetScale: number;
}

/** Bytes one slot occupies: its header, one frame, padded to a cache line. */
export function slotBytes(bones: number): number {
  return roundUp(SLOT_HEADER_BYTES + bones * FLOATS_PER_BONE * 4, 64);
}

/** Where the slots begin: after the header and the rest table. */
export function slotsOffset(bones: number): number {
  return HEADER_BYTES + roundUp(bones * FLOATS_PER_BONE * 4, 64);
}

/** The file's whole size for this many bones and slots. */
export function bridgeBytes(bones: number, slots: number): number {
  return slotsOffset(bones) + slots * slotBytes(bones);
}

function roundUp(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}

/**
 * The writing end, held by the simulation.
 *
 * `open` writes the header and the rest table and creates the sidecar; `publish` writes one
 * frame; `close` marks nothing -- a reader that sees `published` stop advancing already knows.
 */
export class PoseBridgeWriter {
  readonly path: string;
  readonly bones: number;
  readonly slots: number;
  private readonly fd: number;
  private readonly slot: Buffer;
  private readonly header: Buffer;
  private readonly seqs: number[];
  private readonly clock: () => bigint;
  private next = 0;
  private published = 0;

  private constructor(path: string, fd: number, bones: number, slots: number, clock: () => bigint) {
    this.path = path;
    this.fd = fd;
    this.bones = bones;
    this.slots = slots;
    this.clock = clock;
    this.slot = Buffer.alloc(slotBytes(bones));
    this.header = Buffer.alloc(HEADER_BYTES);
    this.seqs = new Array<number>(slots).fill(0);
  }

  static open(rest: RestPose, options: PoseBridgeOptions = {}): PoseBridgeWriter {
    const path = options.path ?? DEFAULT_PATH;
    const slots = options.slots ?? 3;
    const bones = rest.bones.length;
    if (bones === 0) throw new Error('A pose bridge needs at least one bone.');
    if (rest.position.length !== bones * 3 || rest.orientation.length !== bones * 4) {
      throw new Error(
        `The rest pose has ${rest.position.length / 3} positions and ${rest.orientation.length / 4} ` +
          `orientations for ${bones} bones.`,
      );
    }
    if (slots < 2) throw new Error('A pose bridge needs at least two slots, and three is better.');

    const fd = openSync(path, 'w+');
    ftruncateSync(fd, bridgeBytes(bones, slots));
    const writer = new PoseBridgeWriter(
      path,
      fd,
      bones,
      slots,
      options.clock ?? (() => process.hrtime.bigint()),
    );

    // The rest table, once.
    const table = Buffer.alloc(roundUp(bones * FLOATS_PER_BONE * 4, 64));
    for (let b = 0; b < bones; b++) {
      const at = b * FLOATS_PER_BONE * 4;
      table.writeFloatLE(Number(rest.position[b * 3]), at);
      table.writeFloatLE(Number(rest.position[b * 3 + 1]), at + 4);
      table.writeFloatLE(Number(rest.position[b * 3 + 2]), at + 8);
      table.writeFloatLE(Number(rest.orientation[b * 4]), at + 12);
      table.writeFloatLE(Number(rest.orientation[b * 4 + 1]), at + 16);
      table.writeFloatLE(Number(rest.orientation[b * 4 + 2]), at + 20);
      table.writeFloatLE(Number(rest.orientation[b * 4 + 3]), at + 24);
    }
    writeSync(fd, table, 0, table.length, HEADER_BYTES);

    // The header, with no frame yet.
    const h = writer.header;
    h.writeUInt32LE(POSE_BRIDGE_MAGIC, 0);
    h.writeUInt32LE(POSE_BRIDGE_VERSION, 4);
    h.writeUInt32LE(bones, 8);
    h.writeUInt32LE(slots, 12);
    h.writeUInt32LE(NO_FRAME, 16);
    h.writeUInt32LE(slotBytes(bones), 20);
    h.writeDoubleLE(rest.datasetScale, 24);
    h.writeBigUInt64LE(0n, 32);
    writeSync(fd, h, 0, HEADER_BYTES, 0);

    writeFileSync(
      `${path}.json`,
      JSON.stringify({ format: 'bs-humany.pose-bridge/1', bones: rest.bones }, null, 2),
    );
    return writer;
  }

  /**
   * Publish one frame. Never blocks and never waits: whoever reads next gets this one.
   *
   * `position` is `bones * 3` and `orientation` is `bones * 4`, in the order the rest pose named.
   */
  publish(
    tick: number,
    simTime: number,
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
  ): void {
    const index = this.next;
    this.next = (this.next + 1) % this.slots;
    const base = slotsOffset(this.bones) + index * slotBytes(this.bones);
    const seq = (this.seqs[index] ?? 0) + 1;

    const s = this.slot;
    // Odd: a reader arriving now discards what it copies.
    s.writeBigUInt64LE(BigInt(seq), 0);
    writeSync(this.fd, s, 0, 8, base);

    s.writeBigUInt64LE(BigInt(tick), 8);
    s.writeDoubleLE(simTime, 16);
    s.writeBigUInt64LE(this.clock(), 24);
    for (let b = 0; b < this.bones; b++) {
      const at = SLOT_HEADER_BYTES + b * FLOATS_PER_BONE * 4;
      s.writeFloatLE(Number(position[b * 3]), at);
      s.writeFloatLE(Number(position[b * 3 + 1]), at + 4);
      s.writeFloatLE(Number(position[b * 3 + 2]), at + 8);
      s.writeFloatLE(Number(orientation[b * 4]), at + 12);
      s.writeFloatLE(Number(orientation[b * 4 + 1]), at + 16);
      s.writeFloatLE(Number(orientation[b * 4 + 2]), at + 20);
      s.writeFloatLE(Number(orientation[b * 4 + 3]), at + 24);
    }
    writeSync(this.fd, s, 8, s.length - 8, base + 8);

    // Even: complete.
    this.seqs[index] = seq + 1;
    s.writeBigUInt64LE(BigInt(seq + 1), 0);
    writeSync(this.fd, s, 0, 8, base);

    // And now it is the newest.
    this.published += 1;
    this.header.writeUInt32LE(index, 16);
    this.header.writeBigUInt64LE(BigInt(this.published), 32);
    writeSync(this.fd, this.header, 16, 24, 16);
  }

  get framesPublished(): number {
    return this.published;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * Read a bridge file back, for tests and for the fixture generator. Not the renderer's reader --
 * that is Rust, and the whole point of this being here is that the two are checked against each
 * other.
 */
export function readBridge(bytes: Uint8Array): {
  readonly bones: number;
  readonly slots: number;
  readonly newest: number;
  readonly published: number;
  readonly datasetScale: number;
  readonly rest: { position: Float32Array; orientation: Float32Array };
  frame(slot: number): {
    seq: number;
    tick: number;
    simTime: number;
    position: Float32Array;
    orientation: Float32Array;
  };
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== POSE_BRIDGE_MAGIC) throw new Error('Not a pose bridge.');
  if (view.getUint32(4, true) !== POSE_BRIDGE_VERSION) throw new Error('Wrong bridge version.');
  const bones = view.getUint32(8, true);
  const slots = view.getUint32(12, true);
  const unpack = (at: number) => {
    const position = new Float32Array(bones * 3);
    const orientation = new Float32Array(bones * 4);
    for (let b = 0; b < bones; b++) {
      const o = at + b * FLOATS_PER_BONE * 4;
      for (let k = 0; k < 3; k++) position[b * 3 + k] = view.getFloat32(o + k * 4, true);
      for (let k = 0; k < 4; k++) orientation[b * 4 + k] = view.getFloat32(o + 12 + k * 4, true);
    }
    return { position, orientation };
  };
  return {
    bones,
    slots,
    newest: view.getUint32(16, true),
    published: Number(view.getBigUint64(32, true)),
    datasetScale: view.getFloat64(24, true),
    rest: unpack(HEADER_BYTES),
    frame(slot: number) {
      const base = slotsOffset(bones) + slot * slotBytes(bones);
      return {
        seq: Number(view.getBigUint64(base, true)),
        tick: Number(view.getBigUint64(base + 8, true)),
        simTime: view.getFloat64(base + 16, true),
        ...unpack(base + SLOT_HEADER_BYTES),
      };
    },
  };
}
