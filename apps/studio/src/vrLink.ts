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
  /** With no run, what the controls are set to and that there is nothing running. */
  status(simulation: Simulation | null): VrStatus;
  command(command: VrCommand): void;
  log(message: string): void;
}

/** Writes as the Tauri side takes them: `[u32 offset][u32 length][bytes]...`, little endian. */
function pack(writes: readonly BridgeWrite[]): Uint8Array {
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
  return packed;
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

  create(bytes: number, initial: readonly BridgeWrite[]): void {
    // The header and rest table go in the ordered chain, never coalesced: a frame may be dropped
    // for a newer frame, but without these the file is not a bridge at all.
    const packed = pack(initial);
    this.enqueue(async () => {
      await invoke('bridge_create', { name: this.name, bytes });
      await invoke('bridge_write', packed, { headers: { 'x-bridge': this.name } });
    });
  }

  write(writes: readonly BridgeWrite[]): void {
    // Packed now, because the codec reuses its buffers before this is sent.
    this.latest = pack(writes);
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

  /** Settled once everything queued so far has landed. */
  flush(): Promise<void> {
    return this.chain;
  }

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
  private sinks: TauriSink[] = [];
  private order: readonly string[] = [];
  private generation = 0;
  private lastTick = -1;
  private readonly intents = new GrabIntents();
  private grabsInFlight = false;
  private grabsComplained = false;
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
    // Nothing of the last session: a viewer must never open its ring and take it for ours.
    await invoke('bridge_clear');
    this.live = true;
    this.started = performance.now();
    // The bridges first, and landed, so the viewer never opens a file of zeros. A viewer that is
    // launched before a run exists waits for one, but there is no reason to make it.
    const simulation = this.host.simulation();
    if (simulation) {
      this.simulation = simulation;
      this.reopen(simulation);
      await Promise.all(this.sinks.map((sink) => sink.flush()));
    }
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
    await invoke('bridge_clear');
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
      if (simulation) {
        try {
          this.reopen(simulation);
        } catch (error) {
          // Said once, not once a frame; the bridges stay closed until the next run.
          this.host.log(
            `VR viewer: could not open the bridges: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.poses = null;
          this.muscles = null;
        }
      }
    }
    if (!simulation || !this.poses) {
      this.idle();
      return;
    }
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
    if (now - this.lastStatus >= 100) {
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

  /**
   * With no run: still read the panel's commands -- its Resume is how a run is started from the
   * headset -- and still say so in the status, so the panel shows the controls rather than what
   * the last session left behind.
   */
  idle(): void {
    if (!this.live) return;
    const simulation = this.host.simulation();
    if (simulation !== this.simulation) {
      this.simulation = simulation;
      this.intents.letGo(null);
      if (simulation) this.reopen(simulation);
      return;
    }
    const now = performance.now();
    if (now - this.lastCommands >= 100) {
      this.lastCommands = now;
      void this.pollCommands();
    }
    if (now - this.lastStatus >= 100) {
      this.lastStatus = now;
      void this.writeStatus(null);
    }
  }

  private reopen(simulation: Simulation): void {
    this.generation += 1;
    this.lastTick = -1;
    this.order = simulation.boneOrder();
    const rest = this.host.restPose(simulation);
    const poseSink = new TauriSink('', this.host.log);
    this.sinks = [poseSink];
    this.poses = new PoseBridgeWriter(
      new PoseBridgeCodec(rest, undefined, () => BigInt(Math.round(performance.now() * 1e6))),
      poseSink,
    );
    const rings = simulation.muscleRings();
    if (rings) {
      const muscleSink = new TauriSink('-muscles', this.host.log);
      this.sinks.push(muscleSink);
      this.muscles = new MuscleBridgeWriter(
        new MuscleBridgeCodec({ units: rings.units, rings: rings.rings, segments: rings.segments }),
        muscleSink,
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
        // Both reads taken on the Rust side, back to back: two round trips through the page's
        // event loop are a frame apart, and the viewer rewrites the slots faster than that.
        const both = new Uint8Array(
          await invoke<ArrayBuffer>('bridge_read_pair', { name: '-grab' }),
        );
        const half = both.byteLength / 2;
        const first = both.subarray(0, half);
        const second = both.subarray(half);
        if (this.host.simulation() === simulation) {
          const status = this.host.status(simulation);
          const before = this.intents.holding().join(' and ');
          this.intents.apply(
            simulation,
            this.order,
            readGrabIntents(first, second),
            status.grabStrength,
          );
          const after = this.intents.holding().join(' and ');
          if (after !== before) {
            this.host.log(after ? `VR grab: holding ${after}` : 'VR grab: let go');
          }
        }
      } catch (error) {
        // No grab file yet -- the viewer has not opened its end -- is not an error. Anything
        // else is, and is said once.
        const message = error instanceof Error ? error.message : String(error);
        if (!/No such file/.test(message) && !this.grabsComplained) {
          this.grabsComplained = true;
          this.host.log(`VR grabs: ${message}`);
        }
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

  private async writeStatus(simulation: Simulation | null): Promise<void> {
    const status = this.host.status(simulation);
    const text = JSON.stringify({
      ...status,
      generation: this.generation,
      simSeconds: simulation ? simulation.ticks * simulation.dt : 0,
      wallSeconds: (performance.now() - this.started) / 1000,
      speed: status.paused ? 0 : this.speed,
      muscles: simulation !== null && this.muscles !== null,
      holding: this.intents.holding(),
      stepsPerSecond: simulation?.stepsPerSecond ?? 0,
      fps: simulation?.outputFramerate ?? 0,
    });
    try {
      await invoke('bridge_text', { suffix: '-status.json', text });
    } catch (error) {
      this.host.log(`VR status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
