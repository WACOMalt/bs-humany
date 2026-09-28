/**
 * The VR link against a stand-in for its Tauri side.
 *
 * The Tauri side is a few file writes; what can go wrong is on this side of it: which frame is
 * published and under which tick, which bellies go with it, whether a status can reach the
 * viewer before the bridge it names, and whether a refused claim leaves the other program's
 * files alone. So `invoke` is replaced by a small emulation of the commands -- a map of files the
 * batches are applied to -- and the bridges are read back with the codec's own readers, the way
 * the viewer's tests read the fixture.
 */

import { readBridge, readMuscleBridge } from '@bs-humany/pose-bridge/codec';
import type { Simulation } from '@bs-humany/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeFollower } from './follow.js';
import { type VrHost, VrLink, type VrStatus } from './vrLink.js';

interface Call {
  readonly command: string;
  readonly args: unknown;
  readonly headers: Record<string, string>;
}

const tauri = vi.hoisted(() => ({
  calls: [] as Call[],
  files: new Map<string, Uint8Array>(),
  texts: new Map<string, string>(),
  claimHeldBy: null as number | null,
  viewer: { running: true, code: null as number | null, tail: [] as string[] },
}));

/** `[u32 offset][u32 length][bytes]...`, applied to a file the way the Tauri side does. */
function apply(file: Uint8Array, batch: Uint8Array): void {
  const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  let at = 0;
  while (at + 8 <= batch.byteLength) {
    const offset = view.getUint32(at, true);
    const length = view.getUint32(at + 4, true);
    if (offset + length > file.byteLength) throw new Error('a write runs past the end of the file');
    file.set(batch.subarray(at + 8, at + 8 + length), offset);
    at += 8 + length;
  }
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (
    command: string,
    args?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<unknown> => {
    const headers = options?.headers ?? {};
    tauri.calls.push({ command, args, headers });
    switch (command) {
      case 'bridge_claim':
        if (tauri.claimHeldBy !== null) {
          throw new Error(`The studio, a showcase or a publisher (process ${tauri.claimHeldBy})`);
        }
        return undefined;
      case 'bridge_create': {
        const file = new Uint8Array(Number(headers['x-bytes']));
        apply(file, args as Uint8Array);
        tauri.files.set(headers['x-bridge'] ?? '', file);
        return undefined;
      }
      case 'bridge_write': {
        const file = tauri.files.get(headers['x-bridge'] ?? '');
        if (!file) throw new Error('not open');
        apply(file, args as Uint8Array);
        return undefined;
      }
      case 'bridge_text': {
        const { suffix, text } = args as { suffix: string; text: string };
        tauri.texts.set(suffix, text);
        return undefined;
      }
      case 'bridge_close':
        tauri.files.delete('-muscles');
        return undefined;
      case 'bridge_commands':
        return [];
      case 'bridge_read_pair':
        throw new Error('No such file or directory');
      case 'xr_viewer_launch':
        return 'the stand-in viewer';
      case 'xr_viewer_state':
        return { ...tauri.viewer, signal: null };
      default:
        return undefined;
    }
  },
}));

const bones = ['pelvis', 'femur_r'];
const shape = { units: 1, rings: 2, segments: 3 };
const ringsTotal = shape.units * shape.rings;

/** Rings whose every radius is `radius`, so which set was published is plain from the file. */
function rings(radius: number) {
  return {
    position: new Float32Array(ringsTotal * 3),
    orientation: new Float32Array(ringsTotal * 4).fill(0.5),
    radius: new Float32Array(ringsTotal).fill(radius),
  };
}

const live = rings(0.03);
const simulation = {
  ticks: 900,
  dt: 0.002,
  stepsPerSecond: 500,
  outputFramerate: 60,
  boneOrder: () => bones,
  muscleRings: () => ({ ...live, ...shape }),
  grab: { release: () => undefined },
} as unknown as Simulation;

const pose = { position: new Float64Array(bones.length * 3), orientation: new Float64Array(8) };

function host(overrides: Partial<VrHost> = {}): VrHost {
  return {
    simulation: () => simulation,
    restPose: () => ({
      bones,
      position: [0, 1, 0, 0.1, 0.9, 0],
      orientation: [0, 0, 0, 1, 0, 0, 0, 1],
      datasetScale: 1,
    }),
    status: () => ({ paused: false, grabStrength: 1, mode: 'running' }) as unknown as VrStatus,
    command: () => undefined,
    log: () => undefined,
    onViewerExit: () => undefined,
    ...overrides,
  };
}

/** The pose ring's newest frame, and the one before it. */
function lastTwoPoses() {
  const bridge = readBridge(tauri.files.get('') as Uint8Array);
  const newest = bridge.frame(bridge.newest);
  const before = bridge.frame((bridge.newest + bridge.slots - 1) % bridge.slots);
  return { bridge, newest, before };
}

function status(): Record<string, unknown> {
  return JSON.parse(tauri.texts.get('-status.json') ?? 'null') as Record<string, unknown>;
}

let link: VrLink | null = null;

beforeEach(() => {
  tauri.calls.length = 0;
  tauri.files.clear();
  tauri.texts.clear();
  tauri.claimHeldBy = null;
  tauri.viewer = { running: true, code: null, tail: [] };
});

afterEach(async () => {
  vi.useRealTimers();
  if (link?.connected) await link.disconnect();
  link = null;
});

describe('the VR link', () => {
  it('publishes the frame on screen under its own tick, replayed bellies with it', async () => {
    link = new VrLink(host());
    await link.connect();
    // Scrubbed back to tick 40, then stepped back to tick 12: the run itself sits at 900.
    link.frame(pose.position, pose.orientation, 40, rings(0.04));
    await link.flush();
    link.frame(pose.position, pose.orientation, 12, rings(0.012));
    await link.flush();

    const { bridge, newest, before } = lastTwoPoses();
    expect(bridge.published).toBe(2);
    expect(before.tick).toBe(40);
    expect(newest.tick).toBe(12);
    expect(newest.simTime).toBeCloseTo(12 * simulation.dt, 12);

    const muscles = readMuscleBridge(tauri.files.get('-muscles') as Uint8Array);
    const frame = muscles.frame(muscles.newest);
    expect(frame.tick).toBe(12);
    expect(Array.from(frame.radius)).toEqual(Array.from(rings(0.012).radius));

    // The headset's time readout is the playhead's, not the run's. The status goes ten times a
    // second, so the next one is waited for.
    await new Promise((resolve) => setTimeout(resolve, 110));
    link.frame(pose.position, pose.orientation, 12, rings(0.012));
    await link.flush();
    expect(status().simSeconds).toBeCloseTo(12 * simulation.dt, 12);
  });

  it('publishes the live rings on the live edge, and no bellies for a frame with none', async () => {
    link = new VrLink(host());
    await link.connect();
    link.frame(pose.position, pose.orientation, simulation.ticks);
    await link.flush();
    const muscles = () => readMuscleBridge(tauri.files.get('-muscles') as Uint8Array);
    expect(Array.from(muscles().frame(muscles().newest).radius)).toEqual(Array.from(live.radius));

    // A recorded frame whose rings were not captured: the bones go, the newest bellies do not.
    link.frame(pose.position, pose.orientation, 5, null);
    await link.flush();
    expect(lastTwoPoses().newest.tick).toBe(5);
    expect(muscles().published).toBe(1);
    expect(muscles().frame(muscles().newest).tick).toBe(simulation.ticks);
  });

  it('claims before it clears, and never lets a status overtake the bridge it names', async () => {
    link = new VrLink(host());
    await link.connect();
    link.frame(pose.position, pose.orientation, simulation.ticks);
    await link.flush();
    const order = tauri.calls.map((c) => c.command);
    expect(order.indexOf('bridge_claim')).toBeLessThan(order.indexOf('bridge_clear'));
    const created = tauri.calls.findIndex((c) => c.command === 'bridge_create');
    const said = tauri.calls.findIndex(
      (c) =>
        c.command === 'bridge_text' && (c.args as { suffix: string }).suffix === '-status.json',
    );
    expect(created).toBeGreaterThanOrEqual(0);
    expect(said).toBeGreaterThan(created);
    // A generation no earlier page could have used: from the clock, not counted up from zero.
    expect(status().generation as number).toBeGreaterThan(1e12);
    // And the file is a bridge from its creation, header and all, before any frame.
    const create = tauri.calls[created] as Call;
    expect(Number(create.headers['x-bytes'])).toBe(tauri.files.get('')?.byteLength);
  });

  it('touches nothing when another program holds the bridge', async () => {
    tauri.claimHeldBy = 4242;
    link = new VrLink(host());
    await expect(link.connect()).rejects.toThrow(/process 4242/);
    expect(link.connected).toBe(false);
    const touched = tauri.calls.map((c) => c.command);
    expect(touched).toEqual(['bridge_claim']);
  });

  it('says so when the viewer exits, with its last line', async () => {
    vi.useFakeTimers();
    const exits: unknown[][] = [];
    link = new VrLink(host({ onViewerExit: (...args) => void exits.push(args) }));
    await link.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exits).toEqual([]);
    tauri.viewer = { running: false, code: 1, tail: ['starting', 'no headset'] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(exits).toEqual([[1, null, ['starting', 'no headset']]]);
    // Once, not once a second.
    await vi.advanceTimersByTimeAsync(3000);
    expect(exits).toHaveLength(1);
  });

  it('relays a followed publisher on its own bridge, each frame once', async () => {
    link = new VrLink(host({ simulation: () => null }));
    await link.connect();
    const follower = {
      followedShape: {
        bones,
        restPosition: new Float32Array([0, 1, 0, 0.1, 0.9, 0]),
        restOrientation: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
        datasetScale: 1.02,
        version: 1,
      },
      followedGeneration: 1790000000000,
      pose: { bones, ...pose, tick: 3000, simTime: 6 },
      muscles: { ...shape, ...rings(0.05), tick: 3000 },
      status: {
        generation: 1790000000000,
        groundHeight: -0.25,
        training: { task: 'stand', episode: 4 },
        tension: [0.5],
      },
    } as unknown as BridgeFollower;

    link.relay(follower);
    await link.flush();
    const first = lastTwoPoses();
    expect(first.bridge.published).toBe(1);
    expect(first.newest.tick).toBe(3000);
    expect(first.bridge.datasetScale).toBe(1.02);
    const said = status();
    expect(said.mode).toBe('following');
    expect(said.groundHeight).toBe(-0.25);
    expect(said.training).toEqual({ task: 'stand', episode: 4 });
    expect(said.tension).toEqual([0.5]);
    expect(said.simSeconds).toBe(6);
    expect(said.muscles).toBe(true);
    const generation = said.generation as number;

    // The same followed frame again is not published again.
    link.relay(follower);
    await link.flush();
    expect(lastTwoPoses().bridge.published).toBe(1);

    // A new generation of the followed publisher is a new generation here, on new files.
    const replaced = tauri.files.get('');
    (follower as unknown as { followedGeneration: number }).followedGeneration += 1;
    link.relay(follower);
    await link.flush();
    expect(tauri.files.get('')).not.toBe(replaced);
    await new Promise((resolve) => setTimeout(resolve, 110));
    link.relay(follower);
    await link.flush();
    expect(status().generation).toBe(generation + 1);
  });
});
