/**
 * Full-rate capture of every bone's world transform, one frame per simulation tick.
 *
 * The scrubbable timeline keeps a snapshot every tenth of a second and the recording samples at
 * its own cadence; neither is every tick. The Blender export promises a keyframe per tick, so
 * the capture copies the bone-transform channel after every step into growable single-precision
 * chunks. Frames are contiguous in tick number: a rewind truncates, a jump restarts.
 *
 * Memory is the only cost: 206 bones at 500 Hz is about three megabytes a second, so the
 * capture stops itself at a byte budget and says so rather than growing without bound.
 */

export const CAPTURE_BUDGET_BYTES = 256 * 1024 * 1024;
const CHUNK_FRAMES = 256;

export interface CaptureView {
  readonly firstTick: number;
  readonly frames: number;
  readonly bones: number;
  /** `frames * bones * 3` */
  readonly position: Float32Array;
  /** `frames * bones * 4` */
  readonly orientation: Float32Array;
  readonly full: boolean;
}

/**
 * The chunked, budgeted store both captures are built on.
 *
 * One frame is one value per component per item -- three for a position, four for an orientation,
 * one for a radius -- and the streams are kept side by side rather than interleaved, because that
 * is the shape the glTF writer wants them in and interleaving would only mean unpicking it again.
 *
 * Growable in chunks of `CHUNK_FRAMES` so a long run does not reallocate and copy a hundred
 * megabytes; contiguous in tick number, so a rewind truncates and a jump starts over.
 */
class FrameStore {
  private readonly components: readonly number[];
  private readonly budgetBytes: number;
  private items = 0;
  private firstTickValue = 0;
  private frames = 0;
  private chunks: Float32Array[][] = [];
  full = false;

  constructor(components: readonly number[], budgetBytes: number) {
    this.components = components;
    this.budgetBytes = budgetBytes;
  }

  get frameCount(): number {
    return this.frames;
  }

  get itemCount(): number {
    return this.items;
  }

  get firstTick(): number {
    return this.firstTickValue;
  }

  private get floatsPerFrame(): number {
    return this.items * this.components.reduce((t, c) => t + c, 0);
  }

  get bytes(): number {
    return this.frames * this.floatsPerFrame * 4;
  }

  clear(): void {
    this.frames = 0;
    this.firstTickValue = 0;
    this.chunks = [];
    this.full = false;
  }

  append(tick: number, streams: readonly (Float64Array | Float32Array)[]): void {
    if (this.full) return;
    const first = streams[0];
    if (!first) return;
    const items = first.length / (this.components[0] ?? 1);
    if (this.frames === 0 || items !== this.items || tick !== this.firstTickValue + this.frames) {
      this.clear();
      this.items = items;
      this.firstTickValue = tick;
    }
    if (this.bytes + this.floatsPerFrame * 4 > this.budgetBytes) {
      this.full = true;
      return;
    }
    const slot = this.frames % CHUNK_FRAMES;
    if (slot === 0) {
      this.chunks.push(this.components.map((c) => new Float32Array(CHUNK_FRAMES * items * c)));
    }
    const chunk = this.chunks[Math.floor(this.frames / CHUNK_FRAMES)];
    this.components.forEach((c, i) => {
      const stream = streams[i];
      if (stream) chunk?.[i]?.set(stream, slot * items * c);
    });
    this.frames += 1;
  }

  truncate(tick: number): void {
    const keep = Math.max(0, Math.min(this.frames, tick - this.firstTickValue + 1));
    if (keep === 0) {
      this.clear();
      return;
    }
    this.frames = keep;
    this.full = false;
    this.chunks.length = Math.ceil(keep / CHUNK_FRAMES);
  }

  /** One contiguous copy per stream. */
  read(): Float32Array[] {
    return this.components.map((c, i) => {
      const out = new Float32Array(this.frames * this.items * c);
      for (let f = 0; f < this.frames; f++) {
        const chunk = this.chunks[Math.floor(f / CHUNK_FRAMES)]?.[i];
        if (!chunk) continue;
        const slot = f % CHUNK_FRAMES;
        out.set(
          chunk.subarray(slot * this.items * c, (slot + 1) * this.items * c),
          f * this.items * c,
        );
      }
      return out;
    });
  }
}

/**
 * Every muscle ring's frame, one entry per ring per tick.
 *
 * A muscle belly is not rigid in any bone -- it is swept along its path every tick -- but it is
 * rigid ring by ring, so what has to be captured to reproduce it is each ring's own position,
 * orientation and radius. That is what the glTF skin animates, and it is eight floats a ring
 * against the three hundred a ring's vertices would be.
 */
export class MuscleRingCapture {
  private readonly store: FrameStore;

  constructor(budgetBytes: number = CAPTURE_BUDGET_BYTES) {
    this.store = new FrameStore([3, 4, 1], budgetBytes);
  }

  get frameCount(): number {
    return this.store.frameCount;
  }

  get full(): boolean {
    return this.store.full;
  }

  clear(): void {
    this.store.clear();
  }

  truncate(tick: number): void {
    this.store.truncate(tick);
  }

  /** `position` is `rings * 3`, `orientation` `rings * 4`, `radius` `rings`. */
  append(
    tick: number,
    position: Float32Array,
    orientation: Float32Array,
    radius: Float32Array,
  ): void {
    this.store.append(tick, [position, orientation, radius]);
  }

  view(): {
    readonly frames: number;
    readonly rings: number;
    readonly firstTick: number;
    readonly position: Float32Array;
    readonly orientation: Float32Array;
    readonly radius: Float32Array;
    readonly full: boolean;
  } {
    const [position, orientation, radius] = this.store.read();
    return {
      frames: this.store.frameCount,
      rings: this.store.itemCount,
      firstTick: this.store.firstTick,
      position: position ?? new Float32Array(0),
      orientation: orientation ?? new Float32Array(0),
      radius: radius ?? new Float32Array(0),
      full: this.store.full,
    };
  }
}

export class BoneCapture {
  /**
   * Bytes this capture may hold. Injectable so a test can reach the limit without allocating a
   * quarter of a gigabyte to prove it stops.
   */
  private readonly budgetBytes: number;

  constructor(budgetBytes: number = CAPTURE_BUDGET_BYTES) {
    this.budgetBytes = budgetBytes;
  }

  private bones = 0;
  private firstTick = 0;
  private frames = 0;
  private positionChunks: Float32Array[] = [];
  private orientationChunks: Float32Array[] = [];
  full = false;

  get frameCount(): number {
    return this.frames;
  }

  get bytes(): number {
    return this.frames * this.bones * 7 * 4;
  }

  clear(): void {
    this.frames = 0;
    this.firstTick = 0;
    this.positionChunks = [];
    this.orientationChunks = [];
    this.full = false;
  }

  /**
   * Record the transforms of tick `tick`. A tick that does not follow the last starts over.
   *
   * Once the budget is reached nothing more is taken and what is already held is kept, which
   * means the capture holds the beginning of a long run rather than a sliding window. The
   * alternative -- letting the continuity check see the gap the refusal leaves and start over --
   * threw the whole capture away on the tick after the budget was hit, and then again, and
   * again.
   */
  append(tick: number, position: Float64Array, orientation: Float64Array): void {
    if (this.full) return;
    const bones = position.length / 3;
    if (this.frames === 0 || bones !== this.bones) {
      this.clear();
      this.bones = bones;
      this.firstTick = tick;
    } else if (tick !== this.firstTick + this.frames) {
      this.clear();
      this.bones = bones;
      this.firstTick = tick;
    }
    if (this.bytes + bones * 28 > this.budgetBytes) {
      this.full = true;
      return;
    }
    const slot = this.frames % CHUNK_FRAMES;
    if (slot === 0) {
      this.positionChunks.push(new Float32Array(CHUNK_FRAMES * bones * 3));
      this.orientationChunks.push(new Float32Array(CHUNK_FRAMES * bones * 4));
    }
    const chunk = Math.floor(this.frames / CHUNK_FRAMES);
    this.positionChunks[chunk]?.set(position, slot * bones * 3);
    this.orientationChunks[chunk]?.set(orientation, slot * bones * 4);
    this.frames += 1;
  }

  /** Drop every frame after `tick`, so a rewind and re-step overwrites rather than forks. */
  truncate(tick: number): void {
    const keep = Math.max(0, Math.min(this.frames, tick - this.firstTick + 1));
    if (keep === 0) {
      this.clear();
      return;
    }
    this.frames = keep;
    this.full = false;
    const chunks = Math.ceil(keep / CHUNK_FRAMES);
    this.positionChunks.length = chunks;
    this.orientationChunks.length = chunks;
  }

  /** One contiguous copy of the capture. */
  view(): CaptureView {
    const position = new Float32Array(this.frames * this.bones * 3);
    const orientation = new Float32Array(this.frames * this.bones * 4);
    for (let f = 0; f < this.frames; f++) {
      const chunk = Math.floor(f / CHUNK_FRAMES);
      const slot = f % CHUNK_FRAMES;
      const p = this.positionChunks[chunk];
      const o = this.orientationChunks[chunk];
      if (!p || !o) continue;
      position.set(
        p.subarray(slot * this.bones * 3, (slot + 1) * this.bones * 3),
        f * this.bones * 3,
      );
      orientation.set(
        o.subarray(slot * this.bones * 4, (slot + 1) * this.bones * 4),
        f * this.bones * 4,
      );
    }
    return {
      firstTick: this.firstTick,
      frames: this.frames,
      bones: this.bones,
      position,
      orientation,
      full: this.full,
    };
  }
}
