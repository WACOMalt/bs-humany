/**
 * The captures the Blender export and the studio's playback read: every bone's world transform
 * at every tick, and every muscle ring's frame at every tick the bellies were swept.
 *
 * The scrubbable timeline keeps a snapshot every tenth of a second and the recording samples at
 * its own cadence; neither is every tick. The Blender export promises a keyframe per tick, so
 * the bone capture copies the bone-transform channel after every step into growable
 * single-precision chunks, contiguous in tick number: a rewind truncates, a jump restarts. The
 * ring capture is taken at the sweep's own cadence instead, because a belly only changes shape
 * when it is swept, and it records the tick of each frame so a bone tick can find the rings that
 * were showing at it.
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
 * The index of the newest of `count` frames taken at or before `tick`, clamped into the capture.
 *
 * `tickAt` must be strictly increasing, which every capture here is: a tick that does not follow
 * the last starts the capture over. A tick before the first frame gets the first frame, because
 * nothing older exists and the first is the nearest there is; an empty capture gets -1, which
 * every `frameInto` refuses.
 */
export function newestAtOrBefore(
  count: number,
  tickAt: (index: number) => number,
  tick: number,
): number {
  if (count <= 0) return -1;
  if (tick < tickAt(0)) return 0;
  let low = 0;
  let high = count - 1;
  // The frame at `low` is at or before `tick`, and every frame after `high` is after it.
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (tickAt(middle) <= tick) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The chunked, budgeted store the ring capture is built on.
 *
 * One frame is one value per component per item -- three for a position, four for an orientation,
 * one for a radius -- and the streams are kept side by side rather than interleaved, because that
 * is the shape the glTF writer wants them in and interleaving would only mean unpicking it again.
 * Beside them is the tick each frame was taken at, because frames are not one a tick: the bellies
 * are swept on a divisor of the tick rate, and a frame taken between two sweeps would be a copy of
 * the one before it.
 *
 * Growable in chunks of `CHUNK_FRAMES` so a long run does not reallocate and copy a hundred
 * megabytes. Increasing in tick number, with gaps allowed: a rewind truncates, and a tick at or
 * before the newest starts over.
 */
class FrameStore {
  private readonly components: readonly number[];
  private budgetBytes: number;
  private items = 0;
  private frames = 0;
  private chunks: Float32Array[][] = [];
  private tickChunks: Int32Array[] = [];
  /** `tickAt`, bound once, for `newestAtOrBefore`. */
  private readonly tickOf = (index: number): number => this.tickAt(index);
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

  /** The tick of the first frame, or 0 when there is none. */
  get firstTick(): number {
    return this.frames > 0 ? this.tickAt(0) : 0;
  }

  /** The tick of the newest frame, or -1 when there is none. */
  get lastTick(): number {
    return this.frames > 0 ? this.tickAt(this.frames - 1) : -1;
  }

  /** The tick frame `index` was taken at. */
  tickAt(index: number): number {
    return this.tickChunks[Math.floor(index / CHUNK_FRAMES)]?.[index % CHUNK_FRAMES] ?? -1;
  }

  /** @see newestAtOrBefore */
  indexForTick(tick: number): number {
    return newestAtOrBefore(this.frames, this.tickOf, tick);
  }

  /** One frame's floats and its tick, which is what the budget is counted in. */
  private get bytesPerFrame(): number {
    return this.items * this.components.reduce((t, c) => t + c, 0) * 4 + 4;
  }

  get bytes(): number {
    return this.frames * this.bytesPerFrame;
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
   * losing the run. Whether the frames after that belong with the ones before is the caller's
   * business -- the simulation stops the capture again when the run has moved on past it -- and
   * lowering the budget below what is already held does not throw frames away: it stops, and
   * what is there is still exportable.
   */
  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.full = this.bytes + this.bytesPerFrame > bytes;
  }

  clear(): void {
    this.frames = 0;
    this.chunks = [];
    this.tickChunks = [];
    this.full = false;
  }

  append(tick: number, streams: readonly (Float64Array | Float32Array)[]): void {
    if (this.full) return;
    const first = streams[0];
    if (!first) return;
    const items = first.length / (this.components[0] ?? 1);
    if (this.frames === 0 || items !== this.items || tick <= this.lastTick) {
      this.clear();
      this.items = items;
    }
    if (this.bytes + this.bytesPerFrame > this.budgetBytes) {
      this.full = true;
      return;
    }
    const slot = this.frames % CHUNK_FRAMES;
    if (slot === 0) {
      this.chunks.push(this.components.map((c) => new Float32Array(CHUNK_FRAMES * items * c)));
      this.tickChunks.push(new Int32Array(CHUNK_FRAMES));
    }
    const at = Math.floor(this.frames / CHUNK_FRAMES);
    const chunk = this.chunks[at];
    this.components.forEach((c, i) => {
      const stream = streams[i];
      if (stream) chunk?.[i]?.set(stream, slot * items * c);
    });
    const ticks = this.tickChunks[at];
    if (ticks) ticks[slot] = tick;
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

  /** Drop every frame taken after `tick`. */
  truncate(tick: number): void {
    const keep = this.frames > 0 && tick >= this.firstTick ? this.indexForTick(tick) + 1 : 0;
    if (keep === 0) {
      this.clear();
      return;
    }
    this.frames = keep;
    this.full = false;
    const chunks = Math.ceil(keep / CHUNK_FRAMES);
    this.chunks.length = chunks;
    this.tickChunks.length = chunks;
  }

  /** One contiguous copy per stream, and the frames' ticks. */
  read(): { streams: Float32Array[]; ticks: Int32Array } {
    const streams = this.components.map((c, i) => {
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
    const ticks = Int32Array.from({ length: this.frames }, (_, f) => this.tickAt(f));
    return { streams, ticks };
  }
}

/**
 * Every muscle ring's frame, one entry per ring per sweep.
 *
 * A muscle belly is not rigid in any bone -- it is swept along its path -- but it is rigid ring
 * by ring, so what has to be captured to reproduce it is each ring's own position, orientation
 * and radius: eight floats a ring against the three hundred a ring's vertices would be. The PC2
 * vertex cache the Blender export writes and the studio's playback both rebuild the bellies from
 * these.
 *
 * Taken only on the ticks the bellies were swept, which at the sweep's divisor is one tick in
 * four at 500 Hz and one in eight at 1000 Hz: between sweeps the belly does not change, and a
 * frame taken there is a byte-identical copy of the one before. So each frame carries its tick,
 * and `indexForTick` finds the rings that were showing at any bone tick.
 */
export class MuscleRingCapture {
  private readonly store: FrameStore;

  constructor(budgetBytes: number = CAPTURE_BUDGET_BYTES) {
    this.store = new FrameStore([3, 4, 1], budgetBytes);
  }

  get frameCount(): number {
    return this.store.frameCount;
  }

  /** The tick of the first frame, or 0 when there is none. */
  get firstTick(): number {
    return this.store.firstTick;
  }

  /** The tick of the newest frame, or -1 when there is none. */
  get lastTick(): number {
    return this.store.lastTick;
  }

  /** The tick frame `index` was taken at. */
  tickAt(index: number): number {
    return this.store.tickAt(index);
  }

  /**
   * The frame that was showing at `tick`: the newest taken at or before it, clamped into the
   * capture, and -1 when nothing is captured. How a bone tick finds its bellies.
   */
  indexForTick(tick: number): number {
    return this.store.indexForTick(tick);
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

  /** Drop every frame taken after `tick`. */
  truncate(tick: number): void {
    this.store.truncate(tick);
  }

  /**
   * Record the rings swept at `tick`: `position` is `rings * 3`, `orientation` `rings * 4`,
   * `radius` `rings`. A tick later than the newest is kept however much later it is; a tick at or
   * before it starts the capture over.
   */
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
    /** The tick each frame was taken at, strictly increasing. */
    readonly ticks: Int32Array;
    readonly position: Float32Array;
    readonly orientation: Float32Array;
    readonly radius: Float32Array;
    readonly full: boolean;
  } {
    const { streams, ticks } = this.store.read();
    const [position, orientation, radius] = streams;
    return {
      frames: this.store.frameCount,
      rings: this.store.itemCount,
      firstTick: this.store.firstTick,
      ticks,
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
   * Raising it lets a capture that had stopped take frames again. Resume on the next tick and the
   * frames are contiguous; resume after a thousand and the continuity check starts the capture
   * over, because a capture that promises a keyframe per tick cannot pretend a gap is not there.
   * Lowering the budget below what is already held does not throw frames away: it stops, and
   * what is there is still exportable.
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
