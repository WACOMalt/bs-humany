/**
 * Following a publisher: the studio as a reader of the pose bridge.
 *
 * The bridge is a file on tmpfs, which a browser tab cannot open; the training dashboard's
 * server hands the same bytes over localhost, and this polls them -- the pose ring sixty times
 * a second, the muscle ring thirty, the status twice -- and keeps the newest complete frame of
 * each. The seqlock's check is the reader's: a slot whose sequence is odd, or unset, is not a
 * frame. Whoever publishes -- the training showcase, `pnpm publish:pose`, another studio -- is
 * what is shown.
 */

import { readBridge, readMuscleBridge } from '@bs-humany/pose-bridge/codec';

export interface FollowedPose {
  readonly bones: readonly string[];
  readonly position: Float64Array;
  readonly orientation: Float64Array;
  readonly tick: number;
  /** The publisher's simulated seconds at that tick, as its frame says. */
  readonly simTime: number;
}

/**
 * What a followed body is, as against where it is: the bones in order and the rest pose and
 * scale its frames are relative to. The studio's VR link needs it to publish the followed body
 * to the headset on a bridge of its own, which has to carry the same rest table the publisher's
 * does or the headset skins the mesh against the wrong pose.
 */
export interface FollowedShape {
  readonly bones: readonly string[];
  readonly restPosition: Float32Array;
  readonly restOrientation: Float32Array;
  readonly datasetScale: number;
  /** Bumped whenever any of the above changes, so a reader can tell cheaply. */
  readonly version: number;
}

export interface FollowedMuscles {
  readonly units: number;
  readonly rings: number;
  readonly segments: number;
  readonly position: Float32Array;
  readonly orientation: Float32Array;
  readonly radius: Float32Array;
  readonly tick: number;
}

export const DEFAULT_BRIDGE_URL = 'http://localhost:5280/bridge';

export class BridgeFollower {
  pose: FollowedPose | null = null;
  muscles: FollowedMuscles | null = null;
  status: Record<string, unknown> | null = null;
  /** Each unit's tendon force as a fraction of its maximum, when the publisher says. */
  tension: ArrayLike<number> | null = null;
  /** What went wrong last, for the status line; null while it is going well. */
  problem: string | null = null;
  private running = false;
  private bones: string[] | null = null;
  private boneCount = 0;
  private shape: FollowedShape | null = null;
  private shapeVersion = 0;

  constructor(private readonly base: string = DEFAULT_BRIDGE_URL) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop(() => this.readPose(), 16);
    void this.loop(() => this.readMuscles(), 33);
    void this.loop(() => this.readStatus(), 100);
  }

  stop(): void {
    this.running = false;
    this.pose = null;
    this.muscles = null;
    this.status = null;
    this.bones = null;
    this.shape = null;
  }

  get active(): boolean {
    return this.running;
  }

  /** The followed body's bones and rest pose, once a frame of it has been read. */
  get followedShape(): FollowedShape | null {
    return this.shape;
  }

  /**
   * The publisher's own generation, from its status: it changes when the publisher rebuilds its
   * bridges or a new publisher takes the path, which a relay has to pass on.
   */
  get followedGeneration(): number | undefined {
    const generation = this.status?.generation;
    return typeof generation === 'number' ? generation : undefined;
  }

  private async loop(step: () => Promise<void>, everyMs: number): Promise<void> {
    while (this.running) {
      const started = performance.now();
      try {
        await step();
        this.problem = null;
      } catch (error) {
        this.problem = error instanceof Error ? error.message : String(error);
      }
      const wait = Math.max(0, everyMs - (performance.now() - started));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private async bytes(path: string): Promise<Uint8Array | null> {
    const response = await fetch(`${this.base}/${path}`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async readPose(): Promise<void> {
    const bytes = await this.bytes('pose');
    if (!bytes) {
      this.pose = null;
      throw new Error('no publisher: start the showcase, or pnpm publish:pose');
    }
    const bridge = readBridge(bytes);
    if (bridge.newest === 0xffffffff) return;
    // A new publisher can bring the same number of bones in another body -- a different stature,
    // a different rest pose -- so the rest table is compared too, not only the count.
    const restChanged = !this.shape || !sameRest(this.shape, bridge);
    if (!this.bones || this.boneCount !== bridge.bones || restChanged) {
      const response = await fetch(`${this.base}/pose.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error('the bridge has no sidecar');
      this.bones = ((await response.json()) as { bones: string[] }).bones;
      this.boneCount = bridge.bones;
      this.shapeVersion += 1;
      this.shape = {
        bones: this.bones,
        restPosition: bridge.rest.position,
        restOrientation: bridge.rest.orientation,
        datasetScale: bridge.datasetScale,
        version: this.shapeVersion,
      };
    }
    const frame = bridge.frame(bridge.newest);
    if (frame.seq === 0 || frame.seq % 2 === 1) return;
    this.pose = {
      bones: this.bones,
      position: Float64Array.from(frame.position),
      orientation: Float64Array.from(frame.orientation),
      tick: frame.tick,
      simTime: frame.simTime,
    };
  }

  private async readMuscles(): Promise<void> {
    const bytes = await this.bytes('muscles');
    if (!bytes) {
      this.muscles = null;
      return;
    }
    const bridge = readMuscleBridge(bytes);
    if (bridge.newest === 0xffffffff) return;
    const frame = bridge.frame(bridge.newest);
    if (frame.seq === 0 || frame.seq % 2 === 1) return;
    this.muscles = {
      units: bridge.shape.units,
      rings: bridge.shape.rings,
      segments: bridge.shape.segments,
      position: frame.position,
      orientation: frame.orientation,
      radius: frame.radius,
      tick: frame.tick,
    };
  }

  private async readStatus(): Promise<void> {
    const response = await fetch(`${this.base}/status`, { cache: 'no-store' });
    this.status = response.ok ? ((await response.json()) as Record<string, unknown>) : null;
    const tension = this.status?.tension;
    this.tension = Array.isArray(tension) ? (tension as number[]) : null;
  }
}

/** Whether a bridge carries the rest pose and scale a shape was read from. */
function sameRest(
  shape: FollowedShape,
  bridge: {
    readonly datasetScale: number;
    readonly rest: { readonly position: Float32Array; readonly orientation: Float32Array };
  },
): boolean {
  if (shape.datasetScale !== bridge.datasetScale) return false;
  const { position, orientation } = bridge.rest;
  if (position.length !== shape.restPosition.length) return false;
  for (let i = 0; i < position.length; i++) {
    if (position[i] !== shape.restPosition[i]) return false;
  }
  for (let i = 0; i < orientation.length; i++) {
    if (orientation[i] !== shape.restOrientation[i]) return false;
  }
  return true;
}
