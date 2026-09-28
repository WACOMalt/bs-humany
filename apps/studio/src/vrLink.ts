/**
 * The studio as the publisher: what "Connect VR viewer" does.
 *
 * The same bridges `pnpm publish:pose` writes, fed from the studio's own run so the headset shows
 * the body on screen. The page cannot touch tmpfs, so the bytes are built here with the bridge
 * codec and handed to the Tauri side in one batch a frame, which writes them in place; the grab
 * channel and the panel's command log come back the same way. The viewer itself is launched by
 * the Tauri side and stopped on disconnect.
 *
 * The studio publishes on a bridge path of its own (the Tauri side names it), never on the one
 * the showcase and `pnpm publish:pose` share, and it claims that path before touching it. A body
 * the desktop is following -- the training showcase, another publisher -- reaches the headset
 * because this relays it: the followed frames are published again here, on the studio's path, so
 * the viewer the studio launched has one publisher to follow whatever is on screen.
 *
 * Everything that is a decision about the run -- what the panel's buttons do, what the status
 * says -- is the studio's, through `VrHost`; this only carries.
 */

import {
  type BridgeSink,
  type BridgeWrite,
  MuscleBridgeCodec,
  MuscleBridgeWriter,
  type PanelBrain,
  type PanelBrainAction,
  type PanelCommand,
  type PanelStatus,
  PoseBridgeCodec,
  PoseBridgeWriter,
  type RestPose,
  STATUS_SUFFIX,
  grabWritten,
  readGrabIntents,
} from '@bs-humany/pose-bridge/codec';
import { GrabIntents, type Simulation } from '@bs-humany/session';
import { invoke } from '@tauri-apps/api/core';
import type { BrainAction, BrainState } from './brain.js';
import type { BridgeFollower, FollowedMuscles, FollowedShape } from './follow.js';
import { type EchoedCommand, PanelEcho } from './panelEcho.js';

/** What the panel can ask for; the shapes the viewer writes, parsed. */
export type VrCommand = PanelCommand;

/**
 * The keys of the status only the link knows -- which run of the bridges, where the frame on
 * screen is, how fast, what the headset's hands hold -- and the showcase's training run, which
 * reaches the status only when the link relays a showcase.
 */
type LinkKeys =
  | 'generation'
  | 'simSeconds'
  | 'wallSeconds'
  | 'speed'
  | 'muscles'
  | 'holding'
  | 'stepsPerSecond'
  | 'fps'
  | 'training';

/**
 * What the studio says about its run, for the panel: the status every publisher writes, less what
 * the link adds. The panel's own sections, which a headless publisher may not have, the studio
 * always does, so they are required of it here.
 *
 * The brain is the desktop's own `BrainState` -- the type its Brain tab is drawn from -- so the
 * headset gets the button rules and the policy note the desktop shows rather than a copy.
 */
export type VrStatus = Omit<PanelStatus, LinkKeys | 'brain'> &
  Required<
    Pick<PanelStatus, 'mode' | 'overlays' | 'scenarioParameters' | 'muscleReadout' | 'controls'>
  > & {
    readonly brain: BrainState;
  };

/** `true` when A and B have exactly the same keys; a type, so a drift fails to compile. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
type Holds<T extends true> = T;

/**
 * The desktop's brain and the wire's, key for key; and the headset's brain actions and the
 * panel's. Assigning a `BrainState` to the wire's brain already fails on a key the wire wants and
 * the desktop lacks, but not on a key the desktop added and the contract -- and so the Rust side
 * and the fixture -- never heard of. Nor would a Brain tab action the headset cannot send be
 * noticed. These do both.
 */
export type BrainStateIsTheWireBrain = Holds<SameKeys<BrainState, PanelBrain>>;
export type BrainActionsAreThePanels = Holds<
  [BrainAction] extends [PanelBrainAction]
    ? [PanelBrainAction] extends [BrainAction]
      ? true
      : false
    : false
>;

export interface VrHost {
  simulation(): Simulation | null;
  /** The rest pose the mesh pack's vertices are relative to, in the simulation's bone order. */
  restPose(simulation: Simulation): RestPose;
  /** With no run, what the controls are set to and that there is nothing running. */
  status(simulation: Simulation | null): VrStatus;
  command(command: VrCommand): void;
  /** The status line and the terminal: what the desktop user should see happen. */
  log(message: string): void;
  /**
   * The terminal only, for traffic the desktop user does not need in the status line: the
   * panel's commands, echoed as they are applied. A host with no terminal leaves it out, and the
   * traffic is then not said at all.
   */
  trace?(message: string): void;
  /**
   * The viewer has gone -- closed from the headset, failed to find one, crashed. `code` is its
   * exit status, or null when a signal ended it, and `tail` is the last it printed.
   */
  onViewerExit(code: number | null, signal: number | null, tail: readonly string[]): void;
}

/** A replayed frame's muscle rings, in the arrays `Playback.ringsAt` keeps. */
export interface ShownRings {
  readonly position: Float32Array;
  readonly orientation: Float32Array;
  readonly radius: Float32Array;
}

/** What the Tauri side says of the viewer process. */
interface ViewerState {
  readonly running: boolean;
  readonly code: number | null;
  readonly signal?: number | null;
  readonly tail: readonly string[];
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

/**
 * One ordered line of calls to the Tauri side, shared by everything the link writes.
 *
 * Shared, because the order between files is what the viewer depends on. A status naming a new
 * generation tells the viewer to reopen the rings, so it must never land before the rings of that
 * generation exist; and a frame queued for the last generation's pose ring must never land in the
 * new one, which on the Tauri side goes by the same name. With one line for every create, frame
 * and status, each lands after everything queued before it.
 */
class BridgeQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly log: (message: string) => void) {}

  enqueue(task: () => Promise<unknown>): void {
    this.chain = this.chain.then(task).then(
      () => undefined,
      (error) => this.log(`VR bridge: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  /** A text file beside the bridges -- the sidecar, the status -- in its place in the line. */
  text(suffix: string, text: string): void {
    this.enqueue(() => invoke('bridge_text', { suffix, text }));
  }

  /** Settled once everything queued so far has landed. */
  flush(): Promise<void> {
    return this.chain;
  }
}

/** A bridge file on the Tauri side, written in batches, latest batch winning when it falls behind. */
class TauriSink implements BridgeSink {
  private latest: Uint8Array | null = null;
  private queued = false;

  constructor(
    private readonly name: string,
    private readonly queue: BridgeQueue,
  ) {}

  create(bytes: number, initial: readonly BridgeWrite[]): void {
    // The header and rest table travel with the create, in one call, never coalesced: a frame may
    // be dropped for a newer frame, but without these the file is not a bridge at all, and the
    // Tauri side renames the new file into place only once they are in it.
    const packed = pack(initial);
    this.queue.enqueue(() =>
      invoke('bridge_create', packed, {
        headers: { 'x-bridge': this.name, 'x-bytes': String(bytes) },
      }),
    );
  }

  write(writes: readonly BridgeWrite[]): void {
    // Packed now, because the codec reuses its buffers before this is sent.
    this.latest = pack(writes);
    if (this.queued) return;
    this.queued = true;
    this.queue.enqueue(async () => {
      this.queued = false;
      const batch = this.latest;
      this.latest = null;
      if (batch) await invoke('bridge_write', batch, { headers: { 'x-bridge': this.name } });
    });
  }

  sidecar(suffix: string, text: string): void {
    this.queue.text(suffix, text);
  }

  close(): void {}
}

/** A status field of the followed publisher's, when it is a number. */
function numberIn(status: Record<string, unknown> | null, key: string): number | undefined {
  const value = status?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class VrLink {
  private simulation: Simulation | null = null;
  private poses: PoseBridgeWriter | null = null;
  private muscles: MuscleBridgeWriter | null = null;
  private readonly queue: BridgeQueue;
  private order: readonly string[] = [];
  /**
   * Which run of the bridges this is, as the status tells the viewer. Started from the clock, not
   * from zero: a reloaded page is a new link, and one counting from zero again told a viewer that
   * had seen generation 1 from the page before that this was generation 1, so the viewer kept the
   * old files and the headset froze. The clock only names the run; nothing simulated reads it.
   */
  private generation = Date.now();
  /** The tick last published: the frame on screen, which is not always the newest one. */
  private lastTick = -1;
  private lastMuscleTick = -1;
  /** The simulated time of the frame last published, which the status reports as the time. */
  private shownSeconds = 0;
  private readonly intents = new GrabIntents();
  private grabsInFlight = false;
  private grabsComplained = false;
  private lastCommands = 0;
  /** The panel's commands as said on the terminal, a drag at a time; see `PanelEcho`. */
  private readonly echo: PanelEcho;
  private lastStatus = 0;
  private ticksAtStatus = 0;
  private speed = 0;
  private started = performance.now();
  private live = false;
  /** The once-a-second look at whether the viewer is still there, while the link is live. */
  private viewerWatch: ReturnType<typeof setInterval> | null = null;
  private viewerAsked = false;
  /** Relaying a followed publisher: what its bridges were opened for. */
  private relaying = false;
  private relayVersion = -1;
  private relayGeneration: number | undefined;
  private relayUnits = 0;
  private relayRings = 0;
  private relaySegments = 0;

  constructor(private readonly host: VrHost) {
    this.queue = new BridgeQueue(host.log);
    this.echo = new PanelEcho((message) => host.trace?.(message));
  }

  get connected(): boolean {
    return this.live;
  }

  /** Open the bridges for the current run and launch the viewer. Says what was launched. */
  async connect(): Promise<string> {
    // The claim first: the bridge carries one writer, and a refused claim must leave every file
    // of whoever holds it exactly as it was. It throws naming the holder, for the status line.
    await invoke('bridge_claim');
    // Nothing of the last session: a viewer must never open its ring and take it for ours.
    await invoke('bridge_clear');
    this.live = true;
    this.started = performance.now();
    try {
      // The bridges first, and landed, so the viewer never opens a file of zeros. A viewer that
      // is launched before a run exists waits for one, but there is no reason to make it.
      const simulation = this.host.simulation();
      if (simulation) {
        this.simulation = simulation;
        this.reopen(simulation);
        await this.queue.flush();
      }
      const launched = await invoke<string>('xr_viewer_launch');
      this.host.log(`VR viewer: ${launched}`);
      this.watchViewer();
      return launched;
    } catch (error) {
      // No viewer to publish for, so no claim either: whoever runs next must not find this page
      // holding a bridge it gave up on.
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.live = false;
    // A drag cut off by the disconnect is still said, with its count.
    this.echo.flush();
    if (this.viewerWatch !== null) clearInterval(this.viewerWatch);
    this.viewerWatch = null;
    this.intents.letGo(this.simulation);
    this.simulation = null;
    this.poses = null;
    this.muscles = null;
    this.relaying = false;
    // Whatever is still queued lands first, rather than failing against files that are gone.
    await this.queue.flush();
    await invoke('xr_viewer_stop');
    await invoke('bridge_clear');
    await invoke('bridge_release');
  }

  /** Settled once every write queued so far has reached the Tauri side. */
  flush(): Promise<void> {
    return this.queue.flush();
  }

  /**
   * Once an animation frame, after the run advanced, with what the studio is showing: the live
   * bones, or a recorded frame when the playhead is behind the live edge. `shownTick` is the run
   * tick of that frame, and it is what a frame is published under, so a replay reaches the
   * headset frame by frame -- the viewer takes any change of tick as a new frame, earlier ones
   * included. `shownRings` are the recorded bellies of a replayed frame: `undefined` means live,
   * where the simulation's own rings are published, and `null` a recorded frame whose rings were
   * not captured, which publishes no bellies rather than the newest tick's.
   */
  frame(
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
    shownTick: number,
    shownRings?: ShownRings | null,
  ): void {
    if (!this.live) return;
    this.endRelay();
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

    if (shownTick !== this.lastTick) {
      this.lastTick = shownTick;
      this.shownSeconds = shownTick * simulation.dt;
      this.poses.publish(shownTick, this.shownSeconds, position, orientation);
      const rings =
        shownRings === undefined && this.muscles ? simulation.muscleRings() : shownRings;
      const shape = this.muscles?.shape;
      if (rings && shape && rings.radius.length === shape.units * shape.rings) {
        this.muscles?.publish(shownTick, rings.position, rings.orientation, rings.radius);
      }
    }
    // Only on the live edge: a hand in the headset pulls the body that is simulating, and while a
    // recording plays back that body is paused and is not the one on screen.
    if (shownTick === simulation.ticks) this.pollGrabs(simulation);
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
      this.writeStatus(simulation, null);
    }
  }

  /**
   * With no run: still read the panel's commands -- its Resume is how a run is started from the
   * headset -- and still say so in the status, so the panel shows the controls rather than what
   * the last session left behind.
   */
  idle(): void {
    if (!this.live) return;
    this.endRelay();
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
      this.writeStatus(null, null);
    }
  }

  /**
   * While the desktop follows a publisher instead of running a body of its own: publish what it
   * follows, on the studio's bridge, so the headset shows the body the desktop does.
   *
   * Pressing Start training in the headset used to replace the headset's body with nothing: the
   * showcase that training starts publishes on its own path, which the viewer the studio launched
   * does not follow, and the studio sharing that path instead wiped the showcase's files. So the
   * followed frames are published again here, each once, under the publisher's own tick; the
   * bridges are rebuilt whenever the followed body or its generation changes; and the status is
   * the studio's, with the followed body's ground, scenery, tissue, tension and training in it.
   * The panel's commands still come to the studio -- Stop training from the headset is the
   * desktop's Stop. Grabs do not: the followed body is the publisher's to simulate, not this
   * page's.
   */
  relay(follower: BridgeFollower): void {
    if (!this.live) return;
    if (this.simulation) {
      this.simulation = null;
      this.intents.letGo(null);
    }
    const shape = follower.followedShape;
    const muscles = follower.muscles;
    if (shape && this.relayChanged(shape, follower.followedGeneration, muscles)) {
      try {
        this.openRelay(shape, follower.followedGeneration, muscles);
      } catch (error) {
        this.host.log(
          `VR viewer: could not relay the followed body: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.poses = null;
        this.muscles = null;
      }
    }
    const pose = follower.pose;
    if (
      this.poses &&
      pose &&
      pose.tick !== this.lastTick &&
      pose.bones.length === this.order.length
    ) {
      this.lastTick = pose.tick;
      this.shownSeconds = pose.simTime;
      this.poses.publish(pose.tick, pose.simTime, pose.position, pose.orientation);
    }
    if (this.muscles && muscles && muscles.tick !== this.lastMuscleTick) {
      this.lastMuscleTick = muscles.tick;
      this.muscles.publish(muscles.tick, muscles.position, muscles.orientation, muscles.radius);
    }
    const now = performance.now();
    if (now - this.lastCommands >= 100) {
      this.lastCommands = now;
      void this.pollCommands();
    }
    if (now - this.lastStatus >= 100) {
      this.lastStatus = now;
      this.writeStatus(null, follower.status);
    }
  }

  private relayChanged(
    shape: FollowedShape,
    generation: number | undefined,
    muscles: FollowedMuscles | null,
  ): boolean {
    return (
      !this.relaying ||
      shape.version !== this.relayVersion ||
      generation !== this.relayGeneration ||
      (muscles?.units ?? 0) !== this.relayUnits ||
      (muscles?.rings ?? 0) !== this.relayRings ||
      (muscles?.segments ?? 0) !== this.relaySegments
    );
  }

  private openRelay(
    shape: FollowedShape,
    generation: number | undefined,
    muscles: FollowedMuscles | null,
  ): void {
    this.relaying = true;
    this.relayVersion = shape.version;
    this.relayGeneration = generation;
    this.relayUnits = muscles?.units ?? 0;
    this.relayRings = muscles?.rings ?? 0;
    this.relaySegments = muscles?.segments ?? 0;
    this.generation += 1;
    this.lastTick = -1;
    this.lastMuscleTick = -1;
    this.order = shape.bones;
    if (!muscles) this.queue.enqueue(() => invoke('bridge_close', { removeMuscles: true }));
    this.poses = new PoseBridgeWriter(
      new PoseBridgeCodec(
        {
          bones: shape.bones,
          position: shape.restPosition,
          orientation: shape.restOrientation,
          datasetScale: shape.datasetScale,
        },
        undefined,
        () => BigInt(Math.round(performance.now() * 1e6)),
      ),
      new TauriSink('', this.queue),
    );
    this.muscles = muscles
      ? new MuscleBridgeWriter(
          new MuscleBridgeCodec({
            units: muscles.units,
            rings: muscles.rings,
            segments: muscles.segments,
          }),
          new TauriSink('-muscles', this.queue),
        )
      : null;
    this.host.log(
      `VR viewer: relaying the followed body, ${shape.bones.length} bones` +
        (muscles ? ` and ${muscles.units} muscles` : ''),
    );
  }

  /**
   * Back from relaying to the studio's own run, or to none. The relayed writers are dropped; the
   * next run of this page's opens bridges of its own under a new generation, as any run does.
   */
  private endRelay(): void {
    if (!this.relaying) return;
    this.relaying = false;
    this.poses = null;
    this.muscles = null;
    this.lastTick = -1;
    this.lastMuscleTick = -1;
  }

  private reopen(simulation: Simulation): void {
    this.generation += 1;
    this.lastTick = -1;
    this.shownSeconds = simulation.ticks * simulation.dt;
    this.order = simulation.boneOrder();
    const rest = this.host.restPose(simulation);
    const rings = simulation.muscleRings();
    if (!rings) {
      // In the line, ahead of the new pose ring: a run without muscles leaves no belly ring for
      // the viewer to go on drawing the last run's bellies from.
      this.queue.enqueue(() => invoke('bridge_close', { removeMuscles: true }));
    }
    this.poses = new PoseBridgeWriter(
      new PoseBridgeCodec(rest, undefined, () => BigInt(Math.round(performance.now() * 1e6))),
      new TauriSink('', this.queue),
    );
    this.muscles = rings
      ? new MuscleBridgeWriter(
          new MuscleBridgeCodec({
            units: rings.units,
            rings: rings.rings,
            segments: rings.segments,
          }),
          new TauriSink('-muscles', this.queue),
        )
      : null;
    this.host.log(
      `VR viewer: publishing ${this.order.length} bones${rings ? ` and ${rings.units} muscles` : ''}`,
    );
  }

  /**
   * Notice the viewer going, whether the headset closed it, it found no headset, or it crashed.
   *
   * From a timer rather than the frame loop, because a hidden or minimised window gets no
   * animation frames and would otherwise go on saying Disconnect over a viewer that is gone.
   */
  private watchViewer(): void {
    if (this.viewerWatch !== null) clearInterval(this.viewerWatch);
    this.viewerWatch = setInterval(() => {
      if (!this.live || this.viewerAsked) return;
      this.viewerAsked = true;
      void (async () => {
        try {
          const state = await invoke<ViewerState>('xr_viewer_state');
          if (!state.running && this.live) {
            if (this.viewerWatch !== null) clearInterval(this.viewerWatch);
            this.viewerWatch = null;
            this.host.onViewerExit(state.code, state.signal ?? null, state.tail);
          }
        } catch (error) {
          this.host.log(
            `VR viewer: could not ask after the viewer: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          this.viewerAsked = false;
        }
      })();
    }, 1000);
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
          // The write count and the clock are what let go of a hand the viewer has stopped
          // speaking for: killed, or no longer drawing, it leaves its last squeeze in the file.
          // The count comes from the read the slots are parsed from, and the clock is the page's
          // own, taken when the read came back.
          const wentQuiet = this.intents.apply(
            simulation,
            this.order,
            readGrabIntents(first, second),
            status.grabStrength,
            grabWritten(second),
            performance.now(),
          );
          const after = this.intents.holding().join(' and ');
          if (wentQuiet) {
            this.host.log('VR grab: the viewer went quiet, let go');
          } else if (after !== before) {
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
    // Every command is applied as it comes; only what is said of them is merged, a drag to a
    // line, and said on the terminal alone -- the status line is the desktop's, and a drive
    // slider dragged in the headset sends a few dozen commands a second.
    const echoed: EchoedCommand[] = [];
    for (const line of lines) {
      let parsed: VrCommand;
      try {
        parsed = JSON.parse(line) as VrCommand;
      } catch {
        this.host.log(`VR panel: not a command: ${line}`);
        continue;
      }
      echoed.push({ line, command: parsed });
      // One command that throws is said and passed over; the rest of the poll still applies.
      try {
        this.host.command(parsed);
      } catch (error) {
        this.host.log(
          `VR panel: ${line} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.echo.batch(echoed);
  }

  /**
   * The status, in the same line as the bridges it describes, so the generation it names never
   * reaches the viewer before that generation's rings exist.
   *
   * `simSeconds` is the time of the frame on screen -- the playhead when the desktop is scrubbed
   * back, the followed publisher's time when relaying -- so the headset's timeline follows what
   * both displays show. `followed` is the followed publisher's own status while relaying, whose
   * scene the headset needs to draw the body it is sent.
   */
  private writeStatus(
    simulation: Simulation | null,
    followed: Record<string, unknown> | null,
  ): void {
    const status = this.host.status(simulation);
    const relayed = this.relaying ? followed : null;
    // The followed publisher writes this same contract, so what it says is read as that shape;
    // the numbers and arrays are still looked at, as anything another process wrote should be.
    const their = relayed as Partial<PanelStatus> | null;
    const scene: Partial<PanelStatus> = their
      ? {
          mode: 'following',
          groundHeight: numberIn(relayed, 'groundHeight') ?? status.groundHeight,
          staticBoxes: Array.isArray(their.staticBoxes) ? their.staticBoxes : [],
          tissue: their.tissue ?? status.tissue,
          tension: Array.isArray(their.tension) ? their.tension : [],
          ...(their.training ? { training: their.training } : {}),
          paused: typeof their.paused === 'boolean' ? their.paused : false,
        }
      : {};
    // Typed as the whole status, so a key the contract gains and this does not send, or one this
    // sends and the contract does not name, fails to compile rather than reaching the headset as
    // a default.
    const full: PanelStatus = {
      ...status,
      ...scene,
      generation: this.generation,
      simSeconds: simulation || this.relaying ? this.shownSeconds : 0,
      wallSeconds: (performance.now() - this.started) / 1000,
      speed: relayed ? (numberIn(relayed, 'speed') ?? 0) : status.paused ? 0 : this.speed,
      muscles: this.muscles !== null && (simulation !== null || this.relaying),
      holding: this.intents.holding(),
      stepsPerSecond: simulation?.stepsPerSecond ?? numberIn(relayed, 'stepsPerSecond') ?? 0,
      fps: simulation?.outputFramerate ?? numberIn(relayed, 'fps') ?? 0,
    };
    this.queue.text(STATUS_SUFFIX, JSON.stringify(full));
  }
}
