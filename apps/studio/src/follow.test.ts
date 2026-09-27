/**
 * The follower against a dashboard that is not there: `fetch` is a stub answering from a bridge
 * built in memory with the publisher's own codec, and the clock is fake, so a second of polling
 * takes no second and the counts are exact enough to tell one set of loops from two.
 */

import { PoseBridgeCodec } from '@bs-humany/pose-bridge/codec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeFollower, NO_PUBLISHER, publisherBody } from './follow.js';

const BONES = ['pelvis', 'femur_r'];

/** A pose bridge with one frame in it, published at `simTime` seconds of tick `tick`. */
function bridgeBytes(tick: number, simTime: number, datasetScale = 1.02): ArrayBuffer {
  const codec = new PoseBridgeCodec({
    bones: BONES,
    position: [0, 1, 0, 0.1, 0.9, 0],
    orientation: [0, 0, 0, 1, 0, 0, 0, 1],
    datasetScale,
  });
  const file = new ArrayBuffer(codec.bytes);
  const bytes = new Uint8Array(file);
  const apply = (writes: readonly { offset: number; bytes: Uint8Array }[]) => {
    for (const write of writes) bytes.set(write.bytes, write.offset);
  };
  apply(codec.initial());
  apply(codec.publish(tick, simTime, [0, 1, 0, 0.1, 0.9, 0], [0, 0, 0, 1, 0, 0, 0, 1]));
  return file;
}

/** What the dashboard answers for each of the bridge's paths; anything unlisted is a 404. */
type Routes = Partial<Record<'pose' | 'pose.json' | 'muscles' | 'status', () => Promise<Response>>>;

function serve(routes: Routes) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    const path = url.slice(url.lastIndexOf('/bridge/') + '/bridge/'.length) as keyof Routes;
    calls.push(path);
    const route = routes[path];
    return route ? route() : new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

const ok = (body: BodyInit) => async () => new Response(body, { status: 200 });
const json = (value: unknown) => ok(JSON.stringify(value));

describe('BridgeFollower', () => {
  let follower: BridgeFollower;

  beforeEach(() => {
    vi.useFakeTimers();
    follower = new BridgeFollower('http://localhost:5280/bridge');
  });

  afterEach(() => {
    follower.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the publisher's own simulated time, whatever its step rate", async () => {
    // Tick 1000 at one second is a 1 ms step: the tick over 500 said two seconds.
    serve({
      pose: ok(bridgeBytes(1000, 1.0)),
      'pose.json': json({ bones: BONES }),
      status: json({ generation: 1 }),
    });
    follower.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(follower.pose?.tick).toBe(1000);
    expect(follower.pose?.simTime).toBe(1);
    expect(follower.datasetScale).toBeCloseTo(1.02, 12);
    expect(follower.problem).toBeNull();
  });

  it('says to start the dashboard when nothing answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    follower.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(follower.problem).toMatch(/train:dashboard/);
    expect(follower.problem).toContain('localhost:5280');
  });

  it('keeps the no-publisher hint steady while the status still answers', async () => {
    serve({ status: json({ generation: 1 }) });
    follower.start();
    await vi.advanceTimersByTimeAsync(5);
    // Every 5 ms for half a second: the status loop succeeding in between used to clear it.
    for (let at = 0; at < 500; at += 5) {
      expect(follower.problem).toBe(NO_PUBLISHER);
      await vi.advanceTimersByTimeAsync(5);
    }
  });

  it('polls once, not twice, after a stop and a start', async () => {
    const calls = serve({ status: json({}) });
    follower.start();
    follower.stop();
    follower.start();
    await vi.advanceTimersByTimeAsync(1000);
    const poses = calls.filter((path) => path === 'pose').length;
    // Sixty-odd a second is one loop at 16 ms; two loops were a hundred and twenty.
    expect(poses).toBeGreaterThan(50);
    expect(poses).toBeLessThan(70);
  });

  it('drops a response that arrives after a stop', async () => {
    let answer: (response: Response) => void = () => undefined;
    serve({
      pose: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      'pose.json': json({ bones: BONES }),
    });
    follower.start();
    follower.stop();
    answer(new Response(bridgeBytes(10, 0.02)));
    await vi.advanceTimersByTimeAsync(100);
    expect(follower.pose).toBeNull();
    expect(follower.followedShape).toBeNull();
    expect(follower.problem).toBeNull();
    expect(follower.active).toBe(false);
  });

  it("reads the publisher's body from its status, and keeps the same object for the same body", async () => {
    const morphology = {
      sex: 0,
      stature: 1.6,
      mass: 55,
      crural: 1.004,
      brachial: 0.785,
      legLength: 1,
    };
    serve({
      pose: ok(bridgeBytes(10, 0.02)),
      'pose.json': json({ bones: BONES }),
      status: json({ generation: 1, morphology }),
    });
    follower.start();
    await vi.advanceTimersByTimeAsync(150);
    const first = follower.body;
    expect(first?.morphology).toEqual({
      sex: 0,
      stature: 1.6,
      mass: 55,
      proportions: { crural: 1.004, brachial: 0.785, relativeLegLength: 1 },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(follower.body).toBe(first);
    follower.stop();
    expect(follower.body).toBeNull();
  });
});

describe('publisherBody', () => {
  it('is null for a status that names no body, or names one it cannot build', () => {
    expect(publisherBody(null)).toBeNull();
    expect(publisherBody({ settings: {} })).toBeNull();
    expect(publisherBody({ morphology: { sex: 0.5, stature: 1.7 } })).toBeNull();
    expect(publisherBody({ morphology: { sex: 0.5, stature: 0, mass: 70 } })).toBeNull();
    expect(publisherBody({ morphology: 'tall' })).toBeNull();
  });

  it('leaves out the proportions a publisher does not give, for the resolver to default', () => {
    const body = publisherBody({ morphology: { sex: 0.5, stature: 1.7, mass: 70 } });
    expect(body?.morphology).toEqual({ sex: 0.5, stature: 1.7, mass: 70 });
    expect(body?.key).toBe('{"sex":0.5,"stature":1.7,"mass":70}');
  });
});
