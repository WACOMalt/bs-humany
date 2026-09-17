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
 * so rebuilding it is the same arithmetic run backwards rather than an approximation.
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

export interface CapturedFrames {
  readonly frameCount: number;
  readonly boneCount: number;
  frameInto(index: number, position: Float32Array, orientation: Float32Array): boolean;
}

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
   * Belly geometry at one capture index, rebuilt from the rings.
   *
   * Vertex `v` of a ring is at angle `2πv / segments` from the frame's own X axis, in the plane X
   * and Y span, at the ring's radius. That is not a convention chosen here: it is how
   * `captureMuscleRings` measured the frame off the swept mesh -- X toward vertex zero, Z along
   * the ring's normal -- so running it backwards puts every vertex where the sweep had it.
   *
   * The normal is the same direction without the radius, which for a tube is exactly the surface
   * normal rather than an estimate of one.
   */
  bellyAt(
    rings: CapturedRings,
    index: number,
    template: { readonly index: Uint32Array; readonly verticesPerUnit: number },
    ringsPerUnit: number,
    segments: number,
  ): ReplayedMesh | undefined {
    const count = rings.ringCount;
    if (count <= 0 || ringsPerUnit <= 0 || segments <= 0) return undefined;
    if (this.ringRadius.length !== count) {
      this.ringPosition = new Float32Array(count * 3);
      this.ringOrientation = new Float32Array(count * 4);
      this.ringRadius = new Float32Array(count);
    }
    if (!rings.frameInto(index, this.ringPosition, this.ringOrientation, this.ringRadius)) {
      return undefined;
    }
    const vertices = count * segments;
    if (!this.mesh || this.mesh.position.length !== vertices * 3) {
      this.mesh = {
        position: new Float64Array(vertices * 3),
        normal: new Float64Array(vertices * 3),
        index: template.index,
        verticesPerUnit: template.verticesPerUnit,
      };
    }
    const { position, normal } = this.mesh;
    for (let ring = 0; ring < count; ring++) {
      const px = this.ringPosition[3 * ring] as number;
      const py = this.ringPosition[3 * ring + 1] as number;
      const pz = this.ringPosition[3 * ring + 2] as number;
      const qx = this.ringOrientation[4 * ring] as number;
      const qy = this.ringOrientation[4 * ring + 1] as number;
      const qz = this.ringOrientation[4 * ring + 2] as number;
      const qw = this.ringOrientation[4 * ring + 3] as number;
      const r = this.ringRadius[ring] as number;
      for (let v = 0; v < segments; v++) {
        const a = (2 * Math.PI * v) / segments;
        const lx = Math.cos(a);
        const ly = Math.sin(a);
        // q * (lx, ly, 0) * conj(q), written out: the ring plane has no Z component to carry.
        const tx = 2 * (qy * 0 - qz * ly);
        const ty = 2 * (qz * lx - qx * 0);
        const tz = 2 * (qx * ly - qy * lx);
        const nx = lx + qw * tx + (qy * tz - qz * ty);
        const ny = ly + qw * ty + (qz * tx - qx * tz);
        const nz = qw * tz + (qx * ty - qy * tx);
        const at = 3 * (ring * segments + v);
        position[at] = px + r * nx;
        position[at + 1] = py + r * ny;
        position[at + 2] = pz + r * nz;
        normal[at] = nx;
        normal[at + 1] = ny;
        normal[at + 2] = nz;
      }
    }
    return this.mesh;
  }
}
