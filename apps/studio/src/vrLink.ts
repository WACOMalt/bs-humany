/**
 * The studio as the publisher: what "Connect VR viewer" does.
 *
 * The same bridges `pnpm publish:pose` writes, fed from the studio's own run so the headset shows
 * the body on screen. The page cannot touch tmpfs, so the bytes are built here with the bridge
 * codec and handed to the Tauri side in one batch a frame, which writes them in place; the grab
 * channel and the panel's command log come back the same way. The viewer itself is launched by
 * the Tauri side and stopped on disconnect.
 *
 * Everything that is a decision about the run -- what the panel's buttons do, what the status
 * says -- is the studio's, through `VrHost`; this only carries.
 */

import {
  type BridgeSink,
  type BridgeWrite,
  MuscleBridgeCodec,
  MuscleBridgeWriter,
  PoseBridgeCodec,
  PoseBridgeWriter,
  type RestPose,
  readGrabIntents,
} from '@bs-humany/pose-bridge/codec';
import { invoke } from '@tauri-apps/api/core';
import { GrabIntents } from './grabIntents.js';
import type { Simulation } from './simulation.js';

/** What the panel can ask for; the shapes the viewer writes, parsed. */
export type VrCommand =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'reset' }
  | { kind: 'step'; frames: number }
  | { kind: 'scrub'; seconds: number }
  | { kind: 'drive'; group: number; value: number }
  | { kind: 'set'; key: string; value: unknown };

/** What the studio says about its run, for the panel. The link adds what only it knows. */
export interface VrStatus {
  readonly scenario: { readonly id: string; readonly title: string };
  readonly scenarios: readonly { readonly id: string; readonly title: string }[];
  readonly profiles: readonly string[];
  readonly profile: string;
  readonly settings: Readonly<Record<string, number | boolean>>;
  readonly driveGroups: readonly { readonly title: string; readonly level: number }[];
  readonly groundHeight: number;
  readonly staticBoxes: readonly {
    readonly halfExtents: readonly number[];
    readonly position: readonly number[];
    readonly rotation: readonly number[];
  }[];
  readonly grabStrength: number;
  readonly diagnostics: Readonly<Record<string, number>>;
  readonly paused: boolean;
}

export interface VrHost {
  simulation(): Simulation | null;
  /** The rest pose the mesh pack's vertices are relative to, in the simulation's bone order. */
  restPose(simulation: Simulation): RestPose;
  status(simulation: Simulation): VrStatus;
  command(command: VrCommand): void;
  log(message: string): void;
}

/** A bridge file on the Tauri side, written in batches, latest batch winning when it falls behind. */
class TauriSink implements BridgeSink {
  private chain: Promise<void> = Promise.resolve();
  private latest: Uint8Array | null = null;
  private queued = false;

  constructor(
    private readonly name: string,
    private readonly log: (message: string) => void,
  ) {}

  create(bytes: number): void {
    this.enqueue(() => invoke('bridge_create', { name: this.name, bytes }));
  }

  write(writes: readonly BridgeWrite[]): void {
    // Packed now, because the codec reuses its buffers before this is sent.
    let size = 0;
    for (const w of writes) size += 8 + w.bytes.byteLength;
    const packed = new Uint8Array(size);
    const view = new DataView(packed.buffer);
    let at = 0;
    for (const w of writes) {
      view.setUint32(at, w.offset, true);
      view.setUint32(at + 4, w.bytes.byteLength, true);
      packed.set(w.bytes, at + 8);
      at += 8 + w.bytes.byteLength;
    }
    this.latest = packed;
    if (this.queued) return;
    this.queued = true;
    this.enqueue(async () => {
      this.queued = false;
      const batch = this.latest;
      this.latest = null;
      if (batch) await invoke('bridge_write', batch, { headers: { 'x-bridge': this.name } });
    });
  }

  sidecar(suffix: string, text: string): void {
    this.enqueue(() => invoke('bridge_text', { suffix, text }));
  }

  close(): void {}

  private enqueue(task: () => Promise<unknown>): void {
    this.chain = this.chain.then(task).then(
      () => undefined,
      (error) => this.log(`VR bridge: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

export class VrLink {
  private simulation: Simulation | null = null;
  private poses: PoseBridgeWriter | null = null;
  private muscles: MuscleBridgeWriter | null = null;
  private order: readonly string[] = [];
  private generation = 0;
  private lastTick = -1;
  private readonly intents = new GrabIntents();
  private grabsInFlight = false;
  private lastCommands = 0;
  private lastStatus = 0;
  private ticksAtStatus = 0;
  private speed = 0;
  private started = performance.now();
  private live = false;

  constructor(private readonly host: VrHost) {}

  get connected(): boolean {
    return this.live;
  }

  /** Open the bridges for the current run and launch the viewer. Says what was launched. */
  async connect(): Promise<string> {
    this.live = true;
    this.started = performance.now();
    const launched = await invoke<string>('xr_viewer_launch');
    this.host.log(`VR viewer: ${launched}`);
    return launched;
  }

  async disconnect(): Promise<void> {
    this.live = false;
    this.intents.letGo(this.simulation);
    this.simulation = null;
    this.poses = null;
    this.muscles = null;
    await invoke('xr_viewer_stop');
    await invoke('bridge_close', { removeMuscles: true });
  }

  /**
   * Once an animation frame, after the run advanced. `position` and `orientation` are what the
   * studio is showing -- the live bones, or a replayed frame when scrubbed back -- in bone order.
   */
  frame(position: ArrayLike<number>, orientation: ArrayLike<number>): void {
    if (!this.live) return;
    const simulation = this.host.simulation();
    if (simulation !== this.simulation) {
      this.simulation = simulation;
      this.intents.letGo(null);
      if (simulation) this.reopen(simulation);
    }
    if (!simulation || !this.poses) return;
    const now = performance.now();

    if (simulation.ticks !== this.lastTick || this.lastTick < 0) {
      this.lastTick = simulation.ticks;
      this.poses.publish(simulation.ticks, simulation.ticks * simulation.dt, position, orientation);
      const rings = this.muscles ? simulation.muscleRings() : undefined;
      if (rings && rings.radius.length === rings.units * rings.rings) {
        this.muscles?.publish(simulation.ticks, rings.position, rings.orientation, rings.radius);
      }
    }
    this.pollGrabs(simulation);
    if (now - this.lastCommands >= 100) {
      this.lastCommands = now;
      void this.pollCommands();
    }
    if (now - this.lastStatus >= 250) {
      const elapsed = (now - this.lastStatus) / 1000;
      this.speed =
        this.lastStatus === 0
          ? 0
          : ((simulation.ticks - this.ticksAtStatus) * simulation.dt) / elapsed;
      this.lastStatus = now;
      this.ticksAtStatus = simulation.ticks;
      void this.writeStatus(simulation);
    }
  }

  private reopen(simulation: Simulation): void {
    this.generation += 1;
    this.lastTick = -1;
    this.order = simulation.boneOrder();
    const rest = this.host.restPose(simulation);
    this.poses = new PoseBridgeWriter(
      new PoseBridgeCodec(rest, undefined, () => BigInt(Math.round(performance.now() * 1e6))),
      new TauriSink('', this.host.log),
    );
    const rings = simulation.muscleRings();
    if (rings) {
      this.muscles = new MuscleBridgeWriter(
        new MuscleBridgeCodec({ units: rings.units, rings: rings.rings, segments: rings.segments }),
        new TauriSink('-muscles', this.host.log),
      );
    } else {
      this.muscles = null;
      void invoke('bridge_close', { removeMuscles: true }).catch(() => undefined);
    }
    this.host.log(
      `VR viewer: publishing ${this.order.length} bones${rings ? ` and ${rings.units} muscles` : ''}`,
    );
  }

  private pollGrabs(simulation: Simulation): void {
    if (this.grabsInFlight) return;
    this.grabsInFlight = true;
    void (async () => {
      try {
        const first = new Uint8Array(await invoke<ArrayBuffer>('bridge_read', { name: '-grab' }));
        const second = new Uint8Array(await invoke<ArrayBuffer>('bridge_read', { name: '-grab' }));
        if (this.host.simulation() === simulation) {
          const status = this.host.status(simulation);
          this.intents.apply(
            simulation,
            this.order,
            readGrabIntents(first, second),
            status.grabStrength,
          );
        }
      } catch {
        // No grab file yet: the viewer has not opened its end. Not an error.
      } finally {
        this.grabsInFlight = false;
      }
    })();
  }

  private async pollCommands(): Promise<void> {
    let lines: string[];
    try {
      lines = await invoke<string[]>('bridge_commands');
    } catch {
      return;
    }
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as VrCommand;
        this.host.log(`VR panel: ${line}`);
        this.host.command(parsed);
      } catch {
        this.host.log(`VR panel: not a command: ${line}`);
      }
    }
  }

  private async writeStatus(simulation: Simulation): Promise<void> {
    const status = this.host.status(simulation);
    const text = JSON.stringify({
      ...status,
      generation: this.generation,
      simSeconds: simulation.ticks * simulation.dt,
      wallSeconds: (performance.now() - this.started) / 1000,
      speed: status.paused ? 0 : this.speed,
      muscles: this.muscles !== null,
      holding: this.intents.holding(),
      stepsPerSecond: simulation.stepsPerSecond,
      fps: simulation.outputFramerate,
    });
    try {
      await invoke('bridge_text', { suffix: '-status.json', text });
    } catch (error) {
      this.host.log(`VR status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
