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
