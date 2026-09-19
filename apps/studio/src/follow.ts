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
  /** What went wrong last, for the status line; null while it is going well. */
  problem: string | null = null;
  private running = false;
  private bones: string[] | null = null;
  private boneCount = 0;

  constructor(private readonly base: string = DEFAULT_BRIDGE_URL) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop(() => this.readPose(), 16);
    void this.loop(() => this.readMuscles(), 33);
    void this.loop(() => this.readStatus(), 500);
  }

  stop(): void {
    this.running = false;
    this.pose = null;
    this.muscles = null;
    this.status = null;
    this.bones = null;
  }

  get active(): boolean {
    return this.running;
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
    if (!this.bones || this.boneCount !== bridge.bones) {
      const response = await fetch(`${this.base}/pose.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error('the bridge has no sidecar');
      this.bones = ((await response.json()) as { bones: string[] }).bones;
      this.boneCount = bridge.bones;
    }
    const frame = bridge.frame(bridge.newest);
    if (frame.seq === 0 || frame.seq % 2 === 1) return;
    this.pose = {
      bones: this.bones,
      position: Float64Array.from(frame.position),
      orientation: Float64Array.from(frame.orientation),
      tick: frame.tick,
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
  }
}
