/**
 * Playing back what the simulation already computed, without computing any of it again.
 *
 * The studio used to have one idea of time: the simulation ran, and what you saw was wherever it
 * had got to. Scrubbing meant restoring a snapshot and re-stepping to the tick you asked for --
 * which is exact, and which truncated the capture on the way, and which cannot be done sixty
 * times a second. So there was no way to watch a run back.
 *
 * This is the other half. The export capture already holds every bone's transform at every tick,
 * because that is what the export is; a playhead over it is a matter of reading one frame and
 * handing it to the renderer. Nothing is stepped, nothing is truncated, and the simulation can
 * stay exactly where it was left.
 *
 * ## What comes back, and what does not
 *
 * Bones come back exactly -- they are what the capture holds. Muscle bellies come back exactly
 * too, from the ring capture: a ring is a circle of vertices in the plane its frame's X and Y
 * span, at its own radius, which is how the frame was measured off the swept mesh to begin with,
 * so rebuilding it is the same arithmetic run backwards rather than an approximation. The ring
 * capture holds a frame a sweep rather than a frame a tick, because the bellies are swept on a
 * divisor of the tick rate; a bone tick's bellies are the newest sweep at or before it
 * (`MuscleRingCapture.indexForTick`), which is exactly what was on screen at that tick.
 *
 * What does not come back is everything that was never captured: the muscle path polylines, the
 * tension each unit was pulling with, the contact manifolds, the centre of mass. Those are live
 * channels, a tick wide, and holding a history of them would cost more than the bones do. The
 * caller hides the overlays that draw them while the playhead is off the live edge, which is
 * honest and is cheaper than pretending.
 *
 * ## Frames, which are output frames and not ticks
 *
 * The playhead counts in output frames, because that is the thing somebody means by "step a
 * frame" and the thing the exported timeline is divided into. One output frame is
 * `stepsPerSecond / outputFramerate` ticks; playback advances the playhead by wall-clock elapsed
 * times the output frame rate, so a second of captured simulation takes a second to watch.
 */

import { sweepRings } from './ringSweep.js';

export interface CapturedFrames {
  readonly frameCount: number;
  readonly boneCount: number;
  frameInto(index: number, position: Float32Array, orientation: Float32Array): boolean;
}

/**
 * Ring frames by index. An index here is a ring frame's, not a bone frame's: the caller maps a
 * bone tick to one with the capture's `indexForTick`.
 */
export interface CapturedRings {
  readonly frameCount: number;
  readonly ringCount: number;
  frameInto(
    index: number,
    position: Float32Array,
    orientation: Float32Array,
    radius: Float32Array,
  ): boolean;
}

/** The swept belly geometry, in the shape the overlay draws. */
export interface ReplayedMesh {
  readonly position: Float64Array;
  readonly normal: Float64Array;
  readonly index: Uint32Array;
  readonly verticesPerUnit: number;
}

export class Playback {
  /** Where the playhead is, in output frames from the start of the capture. */
  frame = 0;
  playing = false;

  private bonePosition = new Float32Array(0);
  private boneOrientation = new Float32Array(0);
  private livePosition = new Float64Array(0);
  private liveOrientation = new Float64Array(0);

  private ringPosition = new Float32Array(0);
  private ringOrientation = new Float32Array(0);
  private ringRadius = new Float32Array(0);
  /** The three ring arrays together, as `ringsAt` hands them out, remade only when they are. */
  private ringView = {
    position: this.ringPosition,
    orientation: this.ringOrientation,
    radius: this.ringRadius,
  };
  private mesh: ReplayedMesh | undefined;
  /** Zeroes, so a belly drawn from history is drawn relaxed rather than at a stale tension. */
  private slack = new Float64Array(0);

  /** Every buffer is sized on first use, because none of the sizes is known until a run exists. */
  units(count: number): Float64Array {
    if (this.slack.length !== count) this.slack = new Float64Array(count);
    return this.slack;
  }

  /** Output frames the capture holds, given how many ticks one output frame is worth. */
  static frames(ticks: number, ticksPerOutputFrame: number): number {
    if (!(ticksPerOutputFrame > 0) || ticks <= 0) return 0;
    return Math.max(1, Math.floor((ticks - 1) / ticksPerOutputFrame) + 1);
  }

  /** The capture index an output frame sits on. */
  static tickOf(frame: number, ticksPerOutputFrame: number): number {
    return Math.round(frame * ticksPerOutputFrame);
  }

  /**
   * The run's tick an output frame of a capture shows, for a capture whose first frame is
   * `firstTick`. The timeline reads its time from this rather than from the frame alone, because
   * a capture does not always begin at the run's tick 0 -- a carry or a session load starts it
   * where the body arrived -- and a clock counted from the capture's start then disagreed with
   * the status line's, which counts the run's own ticks.
   */
  static runTickOf(frame: number, firstTick: number, ticksPerOutputFrame: number): number {
    return firstTick + Playback.tickOf(frame, ticksPerOutputFrame);
  }

  /**
   * Whether the capture's newest frame is the run's newest tick, so that a frame computed now is
   * recorded onto the end of it and the playhead can show it.
   *
   * An empty capture is at the live edge unless it has been stopped: a carry, a session load and
   * a restore all clear the capture and leave the run where it was, and the next tick is the
   * capture's first. It used to count as a stopped recording, for no better reason than that it
   * had no newest frame to compare, and ▶ on a run paused after moving Stature then went "back to
   * live" without computing anything -- frame-by-frame stepping was dead until Space. `stopped`
   * is whatever says the capture will take no more: a budget that ran out, or a capture full.
   */
  static atLiveEdge(
    capture: { readonly frameCount: number; readonly firstTick: number },
    stopped: boolean,
    runTick: number,
  ): boolean {
    if (capture.frameCount === 0) return !stopped;
    return capture.firstTick + capture.frameCount - 1 === runTick;
  }

  /**
   * The output frame nearest a run's tick, for a capture whose first frame is `firstTick`: the
   * way back from a time somebody asked for -- the headset's timeline says seconds of the run --
   * to the playhead. The caller clamps it into the capture.
   */
  static frameOfTick(tick: number, firstTick: number, ticksPerOutputFrame: number): number {
    if (!(ticksPerOutputFrame > 0)) return 0;
    return Math.round((tick - firstTick) / ticksPerOutputFrame);
  }

  /**
   * Advance the playhead by elapsed wall-clock time, stopping at the end.
   *
   * By the clock rather than one frame per refresh, which is the opposite of how the simulation
   * advances and right for the opposite reason: what is being watched is finished, and watching
   * it should take the time it took. A display slower than the output rate skips frames here,
   * which costs a viewer nothing -- the capture still holds them and the export still writes
   * them.
   */
  advance(elapsedSeconds: number, outputFramerate: number, frameCount: number): void {
    if (!this.playing || frameCount <= 0) return;
    this.frame += elapsedSeconds * outputFramerate;
    if (this.frame >= frameCount - 1) {
      this.frame = frameCount - 1;
      this.playing = false;
    }
  }

  /**
   * The frame on screen: the newest one while following the live edge, the playhead otherwise.
   *
   * While live, `frame` is wherever the playhead was last put -- by the last scrub, or by the
   * last time live was gone back to -- and the run has moved on since, so it is not the frame on
   * screen. Every control that acts relative to the frame on screen asks this instead: a frame
   * back from live used to step back from that stale frame, which after a few seconds of running
   * was the start of the capture.
   */
  at(frameCount: number, live: boolean): number {
    return live ? Math.max(0, frameCount - 1) : this.clampedFrame(frameCount);
  }

  /** Clamp the playhead into a capture of this many frames, and return it as a whole frame. */
  clampedFrame(frameCount: number): number {
    if (frameCount <= 0) return 0;
    this.frame = Math.min(Math.max(this.frame, 0), frameCount - 1);
    return Math.round(this.frame);
  }

  /**
   * Bone transforms at one capture index, in the `Float64Array` pair the renderer wants.
   *
   * The capture is single precision, because at a thousand frames a second double would be two
   * gigabytes an hour for no visible difference. The renderer wants double, so this widens on the
   * way out into arrays it keeps.
   */
  bonesAt(
    capture: CapturedFrames,
    index: number,
  ): { position: Float64Array; orientation: Float64Array } | undefined {
    const bones = capture.boneCount;
    if (bones <= 0) return undefined;
    if (this.bonePosition.length !== bones * 3) {
      this.bonePosition = new Float32Array(bones * 3);
      this.boneOrientation = new Float32Array(bones * 4);
      this.livePosition = new Float64Array(bones * 3);
      this.liveOrientation = new Float64Array(bones * 4);
    }
    if (!capture.frameInto(index, this.bonePosition, this.boneOrientation)) return undefined;
    for (let i = 0; i < bones * 3; i++) this.livePosition[i] = this.bonePosition[i] as number;
    for (let i = 0; i < bones * 4; i++) this.liveOrientation[i] = this.boneOrientation[i] as number;
    return { position: this.livePosition, orientation: this.liveOrientation };
  }

  /** Relaxed tension for every unit, which is what a replayed belly is drawn with. */
  get tension(): Float64Array {
    return this.slack;
  }

  /** Back to the first frame, stopped: what a new run wants. */
  rewind(): void {
    this.frame = 0;
    this.playing = false;
  }

  /**
   * Every belly's rings at one ring-capture index, as they were captured: what the headset is
   * sent while the desktop replays, so it shows the bellies of the frame on screen rather than of
   * the newest tick. Into arrays this keeps -- the same ones `bellyAt` sweeps -- so reading a frame
   * allocates nothing once the first has been read, and the caller consumes them before the next
   * read overwrites them.
   */
  ringsAt(
    rings: CapturedRings,
    index: number,
  ):
    | {
        readonly position: Float32Array;
        readonly orientation: Float32Array;
        readonly radius: Float32Array;
      }
    | undefined {
    const count = rings.ringCount;
    if (count <= 0) return undefined;
    if (this.ringRadius.length !== count) {
      this.ringPosition = new Float32Array(count * 3);
      this.ringOrientation = new Float32Array(count * 4);
      this.ringRadius = new Float32Array(count);
      this.ringView = {
        position: this.ringPosition,
        orientation: this.ringOrientation,
        radius: this.ringRadius,
      };
    }
    if (!rings.frameInto(index, this.ringPosition, this.ringOrientation, this.ringRadius)) {
      return undefined;
    }
    return this.ringView;
  }

  /**
   * Belly geometry at one ring-capture index, rebuilt from the rings by `sweepRings` -- the same
   * sweep the tubes of a followed body and the export's vertex cache use, which says why running
   * the ring frames backwards puts every vertex where the simulation's sweep had it.
   */
  bellyAt(
    rings: CapturedRings,
    index: number,
    template: { readonly index: Uint32Array; readonly verticesPerUnit: number },
    ringsPerUnit: number,
    segments: number,
  ): ReplayedMesh | undefined {
    if (ringsPerUnit <= 0 || segments <= 0) return undefined;
    if (!this.ringsAt(rings, index)) return undefined;
    const count = rings.ringCount;
    const vertices = count * segments;
    if (!this.mesh || this.mesh.position.length !== vertices * 3) {
      this.mesh = {
        position: new Float64Array(vertices * 3),
        normal: new Float64Array(vertices * 3),
        index: template.index,
        verticesPerUnit: template.verticesPerUnit,
      };
    }
    sweepRings(
      this.ringPosition,
      this.ringOrientation,
      this.ringRadius,
      count,
      segments,
      this.mesh.position,
      this.mesh.normal,
    );
    return this.mesh;
  }
}
