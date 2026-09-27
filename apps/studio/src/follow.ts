/**
 * Following a publisher: the studio as a reader of the pose bridge.
 *
 * The bridge is a file on tmpfs, which a browser tab cannot open; the training dashboard's
 * server hands the same bytes over localhost, and this polls them -- the pose ring sixty times
 * a second, the muscle ring thirty, the status ten -- and keeps the newest complete frame of
 * each. The seqlock's check is the reader's: a slot whose sequence is odd, or unset, is not a
 * frame. Whoever publishes -- the training showcase, `pnpm publish:pose`, another studio -- is
 * what is shown.
 */

import type { Morphology } from '@bs-humany/hsdl';
import { readBridge, readMuscleBridge } from '@bs-humany/pose-bridge/codec';

export interface FollowedPose {
  readonly bones: readonly string[];
  readonly position: Float64Array;
  readonly orientation: Float64Array;
  readonly tick: number;
  /**
   * The publisher's simulated seconds at that tick, as its frame says. The tick alone does not
   * say: the step rate is the publisher's profile's, and a tick is 2 ms on one and 1 ms on another.
   */
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

/**
 * The body a publisher says it built its run as, from the `morphology` its status carries: the
 * showcase and `pnpm publish:pose` write it beside the contract's fields, as the flat numbers the
 * studio's sliders hold.
 *
 * The studio needs it because it draws a followed run on a skeleton of its own. The poses on the
 * bridge say where each of the publisher's bones is, and a mesh built for another stature, bound
 * to them, draws every bone at the wrong size about its own origin: the shins stop short of the
 * knees, or overrun them. Built at this, the drawn body is the one being simulated.
 */
export interface PublisherBody {
  readonly morphology: Morphology;
  /** The morphology as text, so a reader can tell cheaply whether the body has changed. */
  readonly key: string;
}

export const DEFAULT_BRIDGE_URL = 'http://localhost:5280/bridge';

/** What the pose loop says when the dashboard serves no bridge: nobody is publishing. */
export const NO_PUBLISHER = 'no publisher: start the showcase, or pnpm publish:pose';

export class BridgeFollower {
  pose: FollowedPose | null = null;
  muscles: FollowedMuscles | null = null;
  status: Record<string, unknown> | null = null;
  /** Each unit's tendon force as a fraction of its maximum, when the publisher says. */
  tension: ArrayLike<number> | null = null;
  /**
   * The body the publisher built its run as, when its status says; null for a publisher that
   * does not. Replaced only when the body changes, so the same body keeps the same object.
   */
  body: PublisherBody | null = null;
  /**
   * What went wrong last, one slot a loop, each written by its own loop only.
   *
   * They used to share one field that every loop cleared on success, so with no publisher the
   * pose loop wrote "no publisher" and the status loop, whose file the dashboard still answered
   * for, cleared it a moment later: the status line flickered between the hint and a bare
   * "Following a publisher", and neither could be read.
   */
  private poseProblem: string | null = null;
  private musclesProblem: string | null = null;
  private statusProblem: string | null = null;
  private running = false;
  /**
   * Which start the loops belong to. A loop carries the generation it was started with and stops,
   * without touching a field, as soon as that is not the current one. Before, a stop and a start
   * inside one poll left the first start's loops running beside the second's -- twice the
   * fetches, for as long as the page stayed open -- and a response that arrived after a stop put
   * a frame back into a follower that had just been cleared.
   */
  private generation = 0;
  private bones: string[] | null = null;
  private boneCount = 0;
  private shape: FollowedShape | null = null;
  private shapeVersion = 0;

  constructor(private readonly base: string = DEFAULT_BRIDGE_URL) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    void this.loop(
      gen,
      16,
      (g) => this.readPose(g),
      (problem) => {
        this.poseProblem = problem;
      },
    );
    void this.loop(
      gen,
      33,
      (g) => this.readMuscles(g),
      (problem) => {
        this.musclesProblem = problem;
      },
    );
    void this.loop(
      gen,
      100,
      (g) => this.readStatus(g),
      (problem) => {
        this.statusProblem = problem;
      },
    );
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.pose = null;
    this.muscles = null;
    this.status = null;
    this.tension = null;
    this.body = null;
    this.bones = null;
    this.boneCount = 0;
    this.shape = null;
    this.poseProblem = null;
    this.musclesProblem = null;
    this.statusProblem = null;
  }

  get active(): boolean {
    return this.running;
  }

  /**
   * What went wrong, for the status line; null while it is going well. The pose's problem first:
   * without poses there is nothing on screen, and that is what somebody needs to hear about.
   */
  get problem(): string | null {
    return this.poseProblem ?? this.musclesProblem ?? this.statusProblem;
  }

  /**
   * The followed bridge's stature over the mesh pack's subject's, as its header says, once a
   * frame of it has been read. Every publisher writes it, so it says how tall the publisher's
   * body is even when the status says nothing more about that body.
   */
  get datasetScale(): number | null {
    return this.shape?.datasetScale ?? null;
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

  private async loop(
    gen: number,
    everyMs: number,
    step: (gen: number) => Promise<void>,
    say: (problem: string | null) => void,
  ): Promise<void> {
    while (this.running && gen === this.generation) {
      const started = performance.now();
      let problem: string | null = null;
      try {
        await step(gen);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      // A stop, or a stop and a start, while the step was waiting: what it found is not this
      // follower's news any more, and neither is what went wrong.
      if (gen !== this.generation) return;
      say(problem);
      const wait = Math.max(0, everyMs - (performance.now() - started));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /**
   * A fetch from the dashboard, with the failure a person can do something about said as such.
   * A fetch that cannot connect rejects with a bare TypeError -- "Failed to fetch", "fetch
   * failed" -- which names neither what was asked for nor what is missing. The dashboard is what
   * serves the bridge, so that is what the message says to start.
   */
  private async get(path: string): Promise<Response> {
    try {
      return await fetch(`${this.base}/${path}`, { cache: 'no-store' });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`no dashboard at ${new URL(this.base).host}: run pnpm train:dashboard`);
      }
      throw error;
    }
  }

  private async bytes(path: string): Promise<Uint8Array | null> {
    const response = await this.get(path);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async readPose(gen: number): Promise<void> {
    const bytes = await this.bytes('pose');
    if (gen !== this.generation) return;
    if (!bytes) {
      this.pose = null;
      throw new Error(NO_PUBLISHER);
    }
    const bridge = readBridge(bytes);
    if (bridge.newest === 0xffffffff) return;
    // A new publisher can bring the same number of bones in another body -- a different stature,
    // a different rest pose -- so the rest table is compared too, not only the count.
    const restChanged = !this.shape || !sameRest(this.shape, bridge);
    if (!this.bones || this.boneCount !== bridge.bones || restChanged) {
      const response = await this.get('pose.json');
      if (!response.ok) throw new Error('the bridge has no sidecar');
      const sidecar = (await response.json()) as { bones: string[] };
      if (gen !== this.generation) return;
      this.bones = sidecar.bones;
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

  private async readMuscles(gen: number): Promise<void> {
    const bytes = await this.bytes('muscles');
    if (gen !== this.generation) return;
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

  private async readStatus(gen: number): Promise<void> {
    const response = await this.get('status');
    const status = response.ok ? ((await response.json()) as Record<string, unknown>) : null;
    if (gen !== this.generation) return;
    this.status = status;
    const tension = status?.tension;
    this.tension = Array.isArray(tension) ? (tension as number[]) : null;
    const body = publisherBody(status);
    if (body?.key !== this.body?.key) this.body = body;
  }
}

/**
 * The body a status says its publisher built, or null when it says none or says it in a shape
 * this cannot use. Sex, stature and mass are what every morphology has; the three proportions are
 * taken when they are numbers and otherwise left to the resolver's defaults, which are what the
 * publisher's own build fell back to.
 */
export function publisherBody(status: Record<string, unknown> | null): PublisherBody | null {
  const said = status?.morphology;
  if (typeof said !== 'object' || said === null) return null;
  const flat = said as Record<string, unknown>;
  const numberAt = (key: string): number | undefined => {
    const value = flat[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const sex = numberAt('sex');
  const stature = numberAt('stature');
  const mass = numberAt('mass');
  if (sex === undefined || stature === undefined || mass === undefined) return null;
  if (!(stature > 0) || !(mass > 0)) return null;
  const crural = numberAt('crural');
  const brachial = numberAt('brachial');
  const relativeLegLength = numberAt('legLength');
  const proportions = {
    ...(crural !== undefined ? { crural } : {}),
    ...(brachial !== undefined ? { brachial } : {}),
    ...(relativeLegLength !== undefined ? { relativeLegLength } : {}),
  };
  // The same keys in the same order as the studio's own `currentMorphology`, so the text of two
  // equal bodies is equal and a mesh built for one is not built again for the other.
  const morphology: Morphology = {
    sex,
    stature,
    mass,
    ...(Object.keys(proportions).length > 0 ? { proportions } : {}),
  };
  return { morphology, key: JSON.stringify(morphology) };
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
