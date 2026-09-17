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

/**
 * What a capture may hold when nobody has said otherwise.
 *
 * A floor rather than a policy: `defaultCaptureBudgetBytes` picks a real one from what the
 * machine will admit to, and this is what it falls back to on a runtime that will not say.
 */
export const CAPTURE_BUDGET_BYTES = 256 * 1024 * 1024;

/** The smallest and largest a caller may set a budget to. */
export const MIN_CAPTURE_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * As much as this machine should be asked for, and why it is not half the host's memory.
 *
 * The studio runs in a browser and a browser does not hand a page the host. What binds is the
 * tab's own JavaScript heap, which Chrome caps around two to four gigabytes however much RAM is
 * underneath, and a capture that runs past it does not stop politely -- the tab dies and takes
 * the run with it. So the ceiling is the heap limit where the runtime reports one
 * (`performance.memory`, Chrome and Edge only), and otherwise a share of `navigator.deviceMemory`,
 * which is the host's RAM rounded to a power of two and capped at eight gigabytes for
 * fingerprinting reasons -- an approximation, and the only one the platform offers.
 *
 * What a *default* takes of that ceiling is a fifth, and the reason is the export rather than the
 * capture: writing the file needs several copies of it live at once. See `EXPORT_PEAK_MULTIPLE`.
 */
export function captureCeilingBytes(): number {
  const heap = (
    globalThis.performance as unknown as { memory?: { jsHeapSizeLimit?: number } } | undefined
  )?.memory?.jsHeapSizeLimit;
  if (typeof heap === 'number' && heap > 0) return heap;
  const device = (globalThis.navigator as unknown as { deviceMemory?: number } | undefined)
    ?.deviceMemory;
  if (typeof device === 'number' && device > 0) return device * 1024 * 1024 * 1024;
  return 4 * 1024 * 1024 * 1024;
}

/**
 * Roughly how much heap the export needs, as a multiple of the capture, at the moment it writes.
 *
 * Counted rather than guessed, for a run with the muscle set going -- which is the expensive case,
 * because the ring capture is twenty times the bone capture:
 *
 *   1.00  the capture itself, in its growable chunks
 *   1.00  `view()`, which copies those chunks into one contiguous block per stream
 *   1.25  the exporter's own keyframe arrays, which cover ring joints and bones together
 *   1.25  the glTF buffer they are packed into
 *
 * A little over four and a half, called five. A budget above a fifth of the ceiling is therefore
 * a budget that captures happily and dies on the Export button, which is the worst of the
 * available failures -- so that is where the default sits. The slider goes higher because the
 * number is an estimate and the person at the keyboard may know better than the estimate.
 */
export const EXPORT_PEAK_MULTIPLE = 5;

/** The budget to start from on this machine: what the export can afford, never below the floor. */
export function defaultCaptureBudgetBytes(): number {
  return Math.max(
    MIN_CAPTURE_BUDGET_BYTES,
    Math.floor(captureCeilingBytes() / EXPORT_PEAK_MULTIPLE),
  );
}

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
  private budgetBytes: number;
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

  /** Stop taking frames without dropping what is held. */
  stop(): void {
    this.full = true;
  }

  /**
   * Change the budget mid-run, keeping every frame already held.
   *
   * Raising it lets a capture that had stopped take frames again, which is the point: somebody
   * watching the status line say the budget was reached should be able to give it more without
   * losing the run. Whether it carries on or starts a new window is the continuity check's
   * business and not this one's -- resume on the next tick and the frames are contiguous, resume
   * after a thousand and they are not, and a capture that promises a keyframe per tick cannot
   * pretend otherwise. Lowering the budget below what is already held does not throw frames
   * away: it stops, and what is there is still exportable.
   */
  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.full = this.bytes + this.floatsPerFrame * 4 > bytes;
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

  /**
   * Read one frame's streams into arrays the caller owns.
   *
   * For playback, which wants one frame at a time and wants it every display refresh. `read()`
   * copies the whole capture into fresh contiguous arrays -- a gigabyte of it, at the budgets this
   * runs at -- which is right for an export and ruinous sixty times a second.
   */
  frameInto(index: number, out: readonly Float32Array[]): boolean {
    if (index < 0 || index >= this.frames) return false;
    const chunk = this.chunks[Math.floor(index / CHUNK_FRAMES)];
    if (!chunk) return false;
    const slot = index % CHUNK_FRAMES;
    for (let i = 0; i < this.components.length; i++) {
      const c = this.components[i] as number;
      const source = chunk[i];
      const target = out[i];
      if (!source || !target) continue;
      target.set(source.subarray(slot * this.items * c, (slot + 1) * this.items * c));
    }
    return true;
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

  get firstTick(): number {
    return this.store.firstTick;
  }

  get bytes(): number {
    return this.store.bytes;
  }

  get full(): boolean {
    return this.store.full;
  }

  /** Stop taking frames without dropping what is held; see `BoneCapture.stop`. */
  stop(): void {
    this.store.stop();
  }

  /** Change the budget mid-run, keeping every frame already held; see `BoneCapture.setBudget`. */
  setBudget(bytes: number): void {
    this.store.setBudget(bytes);
  }

  /** Rings in one frame; see `BoneCapture.frameInto`. */
  get ringCount(): number {
    return this.store.itemCount;
  }

  /**
   * Read one frame's rings into arrays the caller owns: `rings * 3`, `rings * 4`, `rings`.
   *
   * What playback needs to put the bellies back. A ring is a circle of vertices in the plane its
   * frame's X and Y span, at its own radius, which is how the frame was measured off the swept
   * mesh in the first place -- so the mesh comes back exactly rather than approximately.
   */
  frameInto(
    index: number,
    position: Float32Array,
    orientation: Float32Array,
    radius: Float32Array,
  ): boolean {
    return this.store.frameInto(index, [position, orientation, radius]);
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
  private budgetBytes: number;

  constructor(budgetBytes: number = CAPTURE_BUDGET_BYTES) {
    this.budgetBytes = budgetBytes;
  }

  private bones = 0;
  private firstTickValue = 0;
  private frames = 0;
  private positionChunks: Float32Array[] = [];
  private orientationChunks: Float32Array[] = [];
  full = false;

  get frameCount(): number {
    return this.frames;
  }

  get firstTick(): number {
    return this.firstTickValue;
  }

  get bytes(): number {
    return this.frames * this.bones * 7 * 4;
  }

  /**
   * Stop taking frames without dropping what is held.
   *
   * For the caller that keeps two captures the same length: when one reaches its budget the
   * other has to stop too, and `truncate` alone would let it start growing again on the next
   * tick because trimming is normally how a rewind makes room.
   */
  stop(): void {
    this.full = true;
  }

  /**
   * Change the budget mid-run, keeping every frame already held.
   *
   * Raising it lets a capture that had stopped take frames again; see `FrameStore.setBudget` for
   * what happens to contiguity when the run has moved on in the meantime.
   */
  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.full = this.bytes + this.bones * 28 > bytes;
  }

  clear(): void {
    this.frames = 0;
    this.firstTickValue = 0;
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
      this.firstTickValue = tick;
    } else if (tick !== this.firstTickValue + this.frames) {
      this.clear();
      this.bones = bones;
      this.firstTickValue = tick;
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
    const keep = Math.max(0, Math.min(this.frames, tick - this.firstTickValue + 1));
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

  /**
   * Read one frame's transforms into arrays the caller owns: `bones * 3` and `bones * 4`.
   *
   * For playback. `view()` copies the whole capture and allocates while doing it, which is the
   * right shape for an export and the wrong one for sixty times a second.
   */
  frameInto(index: number, position: Float32Array, orientation: Float32Array): boolean {
    if (index < 0 || index >= this.frames) return false;
    const chunk = Math.floor(index / CHUNK_FRAMES);
    const slot = index % CHUNK_FRAMES;
    const p = this.positionChunks[chunk];
    const o = this.orientationChunks[chunk];
    if (!p || !o) return false;
    position.set(p.subarray(slot * this.bones * 3, (slot + 1) * this.bones * 3));
    orientation.set(o.subarray(slot * this.bones * 4, (slot + 1) * this.bones * 4));
    return true;
  }

  /** Bones in one frame, as the capture was fed them. */
  get boneCount(): number {
    return this.bones;
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
      firstTick: this.firstTickValue,
      frames: this.frames,
      bones: this.bones,
      position,
      orientation,
      full: this.full,
    };
  }
}
