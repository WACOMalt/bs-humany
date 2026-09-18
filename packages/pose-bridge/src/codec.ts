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

// ---------------------------------------------------------------------------------------------
// This file is the format and nothing else: no file system, so a browser can build the same bytes
// and hand them to whatever writes them. `node.ts` is the Node end; `index.ts` re-exports both.
// ---------------------------------------------------------------------------------------------

/** One range to write, at an offset from the start of the file. */
export interface BridgeWrite {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/**
 * Where a bridge's bytes go. A sink consumes each write before returning -- the codecs reuse
 * their buffers from one publish to the next -- and writes a batch in order, because the seqlock
 * is the order: odd, body, even, header.
 */
export interface BridgeSink {
  /**
   * Create or truncate the file at this many bytes, all zero, and lay down what a fresh file
   * carries once -- the header, the rest table. Part of creation rather than a first `write`,
   * because a sink that falls behind may drop a frame's writes for a newer frame's, and the
   * header is not a frame: without it the file is not a bridge at all.
   */
  create(bytes: number, initial: readonly BridgeWrite[]): void;
  /** Publish a frame. A sink may let a newer frame's writes overtake and replace these. */
  write(writes: readonly BridgeWrite[]): void;
  /** A text file beside the bridge: `<path><suffix>`. */
  sidecar(suffix: string, text: string): void;
  close(): void;
}

const LITTLE = true;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export const POSE_BRIDGE_MAGIC = 0x50485342;
export const POSE_BRIDGE_VERSION = 1;
export const HEADER_BYTES = 64;
export const FLOATS_PER_BONE = 7;
export const SLOT_HEADER_BYTES = 32;
/** `newest` before any frame has been published. */
export const NO_FRAME = 0xffffffff;
/** Where the bridge lives when nobody says otherwise. */
export const DEFAULT_PATH = '/dev/shm/bs-humany-pose';
/** Slots in a ring: one being written, one being read, one spare. */
export const DEFAULT_SLOTS = 3;

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
 * The pose ring's bytes: what to write to create one, and what to write to publish into one.
 * Pure -- give the writes to a sink. `PoseBridgeWriter` pairs it with one.
 */
export class PoseBridgeCodec {
  readonly bones: number;
  readonly slots: number;
  readonly bytes: number;
  readonly sidecar: string;
  private readonly clock: () => bigint;
  private readonly image: Uint8Array;
  private readonly seqOdd = new Uint8Array(8);
  private readonly seqEven = new Uint8Array(8);
  private readonly body: Uint8Array;
  private readonly headerPatch = new Uint8Array(24);
  private readonly seqs: number[];
  private next = 0;
  private published = 0;

  constructor(rest: RestPose, slots: number = DEFAULT_SLOTS, clock: () => bigint = () => 0n) {
    const bones = rest.bones.length;
    if (bones === 0) throw new Error('A pose bridge needs at least one bone.');
    if (rest.position.length !== bones * 3 || rest.orientation.length !== bones * 4) {
      throw new Error(
        `The rest pose has ${rest.position.length / 3} positions and ${rest.orientation.length / 4} ` +
          `orientations for ${bones} bones.`,
      );
    }
    if (slots < 2) throw new Error('A pose bridge needs at least two slots, and three is better.');
    this.bones = bones;
    this.slots = slots;
    this.clock = clock;
    this.bytes = bridgeBytes(bones, slots);
    this.seqs = new Array<number>(slots).fill(0);
    this.body = new Uint8Array(slotBytes(bones) - 8);
    this.sidecar = JSON.stringify(
      { format: 'bs-humany.pose-bridge/1', bones: rest.bones },
      null,
      2,
    );

    // The header and the rest table, which a fresh file gets once.
    this.image = new Uint8Array(slotsOffset(bones));
    const h = view(this.image);
    h.setUint32(0, POSE_BRIDGE_MAGIC, LITTLE);
    h.setUint32(4, POSE_BRIDGE_VERSION, LITTLE);
    h.setUint32(8, bones, LITTLE);
    h.setUint32(12, slots, LITTLE);
    h.setUint32(16, NO_FRAME, LITTLE);
    h.setUint32(20, slotBytes(bones), LITTLE);
    h.setFloat64(24, rest.datasetScale, LITTLE);
    h.setBigUint64(32, 0n, LITTLE);
    for (let b = 0; b < bones; b++) {
      const at = HEADER_BYTES + b * FLOATS_PER_BONE * 4;
      h.setFloat32(at, Number(rest.position[b * 3]), LITTLE);
      h.setFloat32(at + 4, Number(rest.position[b * 3 + 1]), LITTLE);
      h.setFloat32(at + 8, Number(rest.position[b * 3 + 2]), LITTLE);
      h.setFloat32(at + 12, Number(rest.orientation[b * 4]), LITTLE);
      h.setFloat32(at + 16, Number(rest.orientation[b * 4 + 1]), LITTLE);
      h.setFloat32(at + 20, Number(rest.orientation[b * 4 + 2]), LITTLE);
      h.setFloat32(at + 24, Number(rest.orientation[b * 4 + 3]), LITTLE);
    }
  }

  /** What a fresh, zeroed file of `bytes` needs written: the header and the rest table. */
  initial(): BridgeWrite[] {
    return [{ offset: 0, bytes: this.image }];
  }

  /** The writes that publish one frame, in the order they must land. */
  publish(
    tick: number,
    simTime: number,
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
  ): BridgeWrite[] {
    const index = this.next;
    this.next = (this.next + 1) % this.slots;
    const base = slotsOffset(this.bones) + index * slotBytes(this.bones);
    const seq = (this.seqs[index] ?? 0) + 1;

    // Odd: a reader arriving now discards what it copies.
    view(this.seqOdd).setBigUint64(0, BigInt(seq), LITTLE);
    const s = view(this.body);
    s.setBigUint64(0, BigInt(tick), LITTLE);
    s.setFloat64(8, simTime, LITTLE);
    s.setBigUint64(16, this.clock(), LITTLE);
    for (let b = 0; b < this.bones; b++) {
      const at = SLOT_HEADER_BYTES - 8 + b * FLOATS_PER_BONE * 4;
      s.setFloat32(at, Number(position[b * 3]), LITTLE);
      s.setFloat32(at + 4, Number(position[b * 3 + 1]), LITTLE);
      s.setFloat32(at + 8, Number(position[b * 3 + 2]), LITTLE);
      s.setFloat32(at + 12, Number(orientation[b * 4]), LITTLE);
      s.setFloat32(at + 16, Number(orientation[b * 4 + 1]), LITTLE);
      s.setFloat32(at + 20, Number(orientation[b * 4 + 2]), LITTLE);
      s.setFloat32(at + 24, Number(orientation[b * 4 + 3]), LITTLE);
    }
    // Even: complete. And now it is the newest: bytes 16..40 of the header are newest,
    // slotBytes and datasetScale as they were, then published.
    this.seqs[index] = seq + 1;
    view(this.seqEven).setBigUint64(0, BigInt(seq + 1), LITTLE);
    this.published += 1;
    const h = view(this.headerPatch);
    h.setUint32(0, index, LITTLE);
    h.setUint32(4, slotBytes(this.bones), LITTLE);
    h.setFloat64(8, view(this.image).getFloat64(24, LITTLE), LITTLE);
    h.setBigUint64(16, BigInt(this.published), LITTLE);
    return [
      { offset: base, bytes: this.seqOdd },
      { offset: base + 8, bytes: this.body },
      { offset: base, bytes: this.seqEven },
      { offset: 16, bytes: this.headerPatch },
    ];
  }

  get framesPublished(): number {
    return this.published;
  }
}

/** A pose codec and a sink: the writing end, wherever it runs. */
export class PoseBridgeWriter {
  constructor(
    readonly codec: PoseBridgeCodec,
    private readonly sink: BridgeSink,
  ) {
    sink.create(codec.bytes, codec.initial());
    sink.sidecar('.json', codec.sidecar);
  }

  get bones(): number {
    return this.codec.bones;
  }

  get slots(): number {
    return this.codec.slots;
  }

  publish(
    tick: number,
    simTime: number,
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
  ): void {
    this.sink.write(this.codec.publish(tick, simTime, position, orientation));
  }

  get framesPublished(): number {
    return this.codec.framesPublished;
  }

  close(): void {
    this.sink.close();
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

// ---------------------------------------------------------------------------------------------
// The other direction: a grab, from a hand in the headset back to the simulation.
// ---------------------------------------------------------------------------------------------

/**
 * The layout of the grab-intent file, which the renderer writes and the simulation reads.
 *
 * Same idea as the pose ring, mirrored, and much smaller: one slot per hand, rewritten every
 * frame, seqlocked the same way. The simulation reads both slots each tick and acts on what it
 * finds. A hand that squeezes for less than a tick is a hand that did not grab, which at 144 Hz
 * against a 500 Hz simulation cannot happen.
 *
 *   HEADER, 64 bytes
 *     0   u32  magic       0x42415247, "GRAB"
 *     4   u32  version     1
 *     8   u32  hands       2
 *     12  u32  slotBytes   64
 *     16  u64  written     slot writes so far
 *
 *   SLOT h, at 64 + h * 64
 *     0   u64  seq         odd while being written, even once complete, 0 never
 *     8   u32  active      1 while the hand is squeezing
 *     12  i32  bone        index into the pose bridge's bone order; -1 if the hand held nothing
 *     16  f32  x3 point    world point where the grab began, in the simulation's frame
 *     28  f32  x3 target   world point the hand is at now, in the simulation's frame
 *     40  f32  strength    the spring the grab module scales; 1 is the studio's default
 *     44  f32  x4 rotation the hand's orientation now, xyzw, in the simulation's frame
 *
 * The renderer converts out of its own stage space before writing, so both points arrive in the
 * simulation's world -- the frame `segmentPose` answers in -- and the simulation never has to
 * know where the body was placed in the room.
 */
export const GRAB_MAGIC = 0x42415247;
export const GRAB_VERSION = 1;
export const GRAB_HANDS = 2;
export const GRAB_SLOT_BYTES = 64;
export const GRAB_BYTES = HEADER_BYTES + GRAB_HANDS * GRAB_SLOT_BYTES;
/** Where the intents live when nobody says otherwise: beside the pose bridge. */
export const DEFAULT_GRAB_PATH = `${DEFAULT_PATH}-grab`;

export interface GrabIntent {
  readonly active: boolean;
  /** Index into the pose bridge's bone order, or -1. */
  readonly bone: number;
  readonly point: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly strength: number;
  readonly rotation: readonly [number, number, number, number];
}

/** Parse one hand's slot out of a whole-file buffer, or undefined if it is mid-write or unwritten. */
export function readGrabSlot(bytes: Uint8Array, hand: number): GrabIntent | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < GRAB_BYTES || view.getUint32(0, true) !== GRAB_MAGIC) return undefined;
  const base = HEADER_BYTES + hand * GRAB_SLOT_BYTES;
  const seq = view.getBigUint64(base, true);
  if (seq === 0n || seq % 2n === 1n) return undefined;
  return {
    active: view.getUint32(base + 8, true) === 1,
    bone: view.getInt32(base + 12, true),
    point: [
      view.getFloat32(base + 16, true),
      view.getFloat32(base + 20, true),
      view.getFloat32(base + 24, true),
    ],
    target: [
      view.getFloat32(base + 28, true),
      view.getFloat32(base + 32, true),
      view.getFloat32(base + 36, true),
    ],
    strength: view.getFloat32(base + 40, true),
    rotation: [
      view.getFloat32(base + 44, true),
      view.getFloat32(base + 48, true),
      view.getFloat32(base + 52, true),
      view.getFloat32(base + 56, true),
    ],
  };
}

/**
 * Both hands out of two successive reads of the whole file. A seqlock needs the sequence read
 * before and after the body; a single read is not guaranteed atomic against a concurrent mapped
 * write, so the file is read twice and a slot is trusted only when its sequence agrees between
 * the two. A hand that could not be read cleanly is undefined this time round.
 */
export function readGrabIntents(
  first: Uint8Array,
  second: Uint8Array,
): [GrabIntent | undefined, GrabIntent | undefined] {
  const hands: [GrabIntent | undefined, GrabIntent | undefined] = [undefined, undefined];
  if (first.byteLength < GRAB_BYTES || second.byteLength < GRAB_BYTES) return hands;
  const a = view(first);
  const b = view(second);
  for (let h = 0; h < GRAB_HANDS; h++) {
    const base = HEADER_BYTES + h * GRAB_SLOT_BYTES;
    if (a.getBigUint64(base, LITTLE) !== b.getBigUint64(base, LITTLE)) continue;
    hands[h] = readGrabSlot(second, h);
  }
  return hands;
}

// ---------------------------------------------------------------------------------------------
// The muscles: a ring of belly rings, alongside the ring of poses.
// ---------------------------------------------------------------------------------------------

/**
 * The layout of the muscle bridge, `<pose path>-muscles`.
 *
 * What crosses is not the belly meshes but their rings -- centre, orientation, radius: eight
 * floats -- because a swept tube's vertices are a function of its rings and the renderer can
 * sweep them itself, and because eight floats a ring is a hundred times less than the vertices.
 * At 148 bellies of 24 rings that is 113 KB a frame; three slots of it is what the file holds.
 *
 *   HEADER, 64 bytes
 *     0   u32  magic       0x4353554d, "MUSC"
 *     4   u32  version     1
 *     8   u32  units       bellies
 *     12  u32  rings       rings a belly
 *     16  u32  segments    vertices round a ring, which the renderer sweeps with
 *     20  u32  slots
 *     24  u32  newest      slot holding the newest complete frame, or NO_FRAME
 *     28  u32  slotBytes
 *     32  u64  published   frames so far
 *
 *   SLOT, at 64 + slot * slotBytes, slotBytes = roundUp(16 + units * rings * 32, 64)
 *     0   u64  seq         odd while being written, even once complete, 0 never
 *     8   u64  tick
 *     16  f32  x8 a ring   position xyz, orientation xyzw, radius; ring r of unit u at u*rings+r
 *
 * Rings are in the simulation's world frame at the body's own stature, which is where the sweep
 * put them; unlike bones there is no rest pose and no dataset scale to apply.
 */
export const MUSCLE_MAGIC = 0x4353554d;
export const MUSCLE_VERSION = 1;
export const FLOATS_PER_RING = 8;
export const MUSCLE_SLOT_HEADER_BYTES = 16;

export function muscleSlotBytes(ringsTotal: number): number {
  return roundUp(MUSCLE_SLOT_HEADER_BYTES + ringsTotal * FLOATS_PER_RING * 4, 64);
}

export function muscleBridgeBytes(ringsTotal: number, slots: number): number {
  return HEADER_BYTES + slots * muscleSlotBytes(ringsTotal);
}

export interface MuscleShape {
  readonly units: number;
  readonly rings: number;
  readonly segments: number;
}

/** The muscle ring's bytes, as `PoseBridgeCodec` is the pose ring's. */
export class MuscleBridgeCodec {
  readonly shape: MuscleShape;
  readonly slots: number;
  readonly bytes: number;
  private readonly image = new Uint8Array(HEADER_BYTES);
  private readonly seqOdd = new Uint8Array(8);
  private readonly seqEven = new Uint8Array(8);
  private readonly body: Uint8Array;
  private readonly headerPatch = new Uint8Array(16);
  private readonly seqs: number[];
  private next = 0;
  private published = 0;

  constructor(shape: MuscleShape, slots: number = DEFAULT_SLOTS) {
    if (shape.units < 1 || shape.rings < 2 || shape.segments < 3) {
      throw new RangeError(
        `a muscle bridge needs a unit, two rings and three segments; got ${JSON.stringify(shape)}`,
      );
    }
    this.shape = shape;
    this.slots = slots;
    const total = shape.units * shape.rings;
    this.bytes = muscleBridgeBytes(total, slots);
    this.body = new Uint8Array(muscleSlotBytes(total) - 8);
    this.seqs = new Array<number>(slots).fill(0);
    const h = view(this.image);
    h.setUint32(0, MUSCLE_MAGIC, LITTLE);
    h.setUint32(4, MUSCLE_VERSION, LITTLE);
    h.setUint32(8, shape.units, LITTLE);
    h.setUint32(12, shape.rings, LITTLE);
    h.setUint32(16, shape.segments, LITTLE);
    h.setUint32(20, slots, LITTLE);
    h.setUint32(24, NO_FRAME, LITTLE);
    h.setUint32(28, muscleSlotBytes(total), LITTLE);
    h.setBigUint64(32, 0n, LITTLE);
  }

  initial(): BridgeWrite[] {
    return [{ offset: 0, bytes: this.image }];
  }

  /** `position` is 3 a ring, `orientation` 4, `radius` 1, all `units * rings` long. */
  publish(
    tick: number,
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
    radius: ArrayLike<number>,
  ): BridgeWrite[] {
    const total = this.shape.units * this.shape.rings;
    if (
      position.length !== total * 3 ||
      orientation.length !== total * 4 ||
      radius.length !== total
    ) {
      throw new RangeError(`the rings given are not ${total} rings' worth.`);
    }
    const index = this.next;
    this.next = (this.next + 1) % this.slots;
    const base = HEADER_BYTES + index * muscleSlotBytes(total);
    const seq = (this.seqs[index] ?? 0) + 1;
    view(this.seqOdd).setBigUint64(0, BigInt(seq), LITTLE);
    const s = view(this.body);
    s.setBigUint64(0, BigInt(tick), LITTLE);
    for (let r = 0; r < total; r++) {
      const at = MUSCLE_SLOT_HEADER_BYTES - 8 + r * FLOATS_PER_RING * 4;
      s.setFloat32(at, Number(position[r * 3]), LITTLE);
      s.setFloat32(at + 4, Number(position[r * 3 + 1]), LITTLE);
      s.setFloat32(at + 8, Number(position[r * 3 + 2]), LITTLE);
      s.setFloat32(at + 12, Number(orientation[r * 4]), LITTLE);
      s.setFloat32(at + 16, Number(orientation[r * 4 + 1]), LITTLE);
      s.setFloat32(at + 20, Number(orientation[r * 4 + 2]), LITTLE);
      s.setFloat32(at + 24, Number(orientation[r * 4 + 3]), LITTLE);
      s.setFloat32(at + 28, Number(radius[r]), LITTLE);
    }
    this.seqs[index] = seq + 1;
    view(this.seqEven).setBigUint64(0, BigInt(seq + 1), LITTLE);
    this.published += 1;
    // Bytes 24..40 of the header: newest, slotBytes as it was, published.
    const h = view(this.headerPatch);
    h.setUint32(0, index, LITTLE);
    h.setUint32(4, muscleSlotBytes(total), LITTLE);
    h.setBigUint64(8, BigInt(this.published), LITTLE);
    return [
      { offset: base, bytes: this.seqOdd },
      { offset: base + 8, bytes: this.body },
      { offset: base, bytes: this.seqEven },
      { offset: 24, bytes: this.headerPatch },
    ];
  }

  get framesPublished(): number {
    return this.published;
  }
}

export class MuscleBridgeWriter {
  constructor(
    readonly codec: MuscleBridgeCodec,
    private readonly sink: BridgeSink,
  ) {
    sink.create(codec.bytes, codec.initial());
  }

  get shape(): MuscleShape {
    return this.codec.shape;
  }

  publish(
    tick: number,
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
    radius: ArrayLike<number>,
  ): void {
    this.sink.write(this.codec.publish(tick, position, orientation, radius));
  }

  get framesPublished(): number {
    return this.codec.framesPublished;
  }

  close(): void {
    this.sink.close();
  }
}

/** Read a whole muscle bridge back, for tests and tools. */
export function readMuscleBridge(bytes: Uint8Array): {
  readonly shape: MuscleShape;
  readonly slots: number;
  readonly newest: number;
  readonly published: number;
  frame(slot: number): {
    readonly seq: number;
    readonly tick: number;
    readonly position: Float32Array;
    readonly orientation: Float32Array;
    readonly radius: Float32Array;
  };
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MUSCLE_MAGIC) throw new Error('not a muscle bridge');
  const shape = {
    units: view.getUint32(8, true),
    rings: view.getUint32(12, true),
    segments: view.getUint32(16, true),
  };
  const total = shape.units * shape.rings;
  const slotLength = view.getUint32(28, true);
  return {
    shape,
    slots: view.getUint32(20, true),
    newest: view.getUint32(24, true),
    published: Number(view.getBigUint64(32, true)),
    frame(slot) {
      const base = HEADER_BYTES + slot * slotLength;
      const position = new Float32Array(total * 3);
      const orientation = new Float32Array(total * 4);
      const radius = new Float32Array(total);
      for (let r = 0; r < total; r++) {
        const at = base + MUSCLE_SLOT_HEADER_BYTES + r * FLOATS_PER_RING * 4;
        for (let i = 0; i < 3; i++) position[r * 3 + i] = view.getFloat32(at + 4 * i, true);
        for (let i = 0; i < 4; i++) orientation[r * 4 + i] = view.getFloat32(at + 12 + 4 * i, true);
        radius[r] = view.getFloat32(at + 28, true);
      }
      return {
        seq: Number(view.getBigUint64(base, true)),
        tick: Number(view.getBigUint64(base + 8, true)),
        position,
        orientation,
        radius,
      };
    },
  };
}
