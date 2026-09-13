import { describe, expect, it } from 'vitest';
import { KernelProxy, WorkerHost } from './host.js';
import type { PortLike } from './transport.js';
import type { ChannelSpec, ChannelView, ModuleManifest, SimModule } from './types.js';

function portPair(): [PortLike, PortLike] {
  const mc = new MessageChannel();
  const wrap = (p: InstanceType<typeof MessagePort>): PortLike => {
    const like: PortLike = {
      postMessage: (m, t) => (t ? p.postMessage(m, t) : p.postMessage(m)),
      onmessage: null,
    };
    p.on('message', (data: unknown) => like.onmessage?.({ data }));
    return like;
  };
  return [wrap(mc.port1), wrap(mc.port2)];
}

const POSE: ChannelSpec = {
  id: 'body.pose',
  version: '1.0.0',
  layout: 'SoA',
  fields: [{ name: 'position', dtype: 'f64', components: 1 }],
  elementCount: 1,
  mode: 'single-writer',
  backing: 'shared',
};

const manifest: ModuleManifest = {
  id: 'physics',
  version: '1.0.0',
  phase: 'solve',
  dependsOn: [],
  reads: [],
  writes: [{ id: POSE.id, version: '^1.0.0' }],
  accumulates: [],
  gives: [POSE],
};

/** Counts ticks into the pose channel, so the main thread can see progress. */
function counter(): SimModule {
  let pose: ChannelView | undefined;
  return {
    manifest,
    init(ctx) {
      pose = ctx.write(POSE.id);
    },
    step() {
      const p = pose?.fields.position as Float64Array;
      p[0] = (p[0] ?? 0) + 1;
    },
  };
}

async function pair(preferShared: boolean) {
  const [hostControl, proxyControl] = portPair();
  const [hostData, proxyData] = portPair();
  const host = new WorkerHost(hostControl, hostData, () => [counter()]);
  const proxy = new KernelProxy(proxyControl, proxyData);
  await proxy.init({ rateHz: 100, seed: 3, preferShared }, [POSE.id]);
  return { host, proxy };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

for (const preferShared of [false, true]) {
  describe(`worker host over a message channel (preferShared=${preferShared})`, () => {
    it('initialises, reports the order, runs, and publishes frames', async () => {
      const { proxy } = await pair(preferShared);
      expect(proxy.order).toEqual(['physics']);
      const r = await proxy.run(5);
      expect(r.tick).toBe(5);
      await settle();
      const frame = proxy.latestFrame;
      expect(frame?.tick).toBe(5);
      const bytes = frame?.channels[POSE.id];
      expect(bytes).toBeDefined();
      if (!bytes) return;
      // The count header occupies the first 8 bytes; the f64 field follows.
      expect(new Float64Array(bytes.buffer, bytes.byteOffset + 8, 1)[0]).toBe(5);
    });

    it('round-trips a snapshot through the proxy', async () => {
      const { proxy } = await pair(preferShared);
      await proxy.run(3);
      const snap = await proxy.snapshot();
      const { stateHash: after } = await proxy.run(4);
      await proxy.restore(snap);
      const { stateHash: again } = await proxy.run(4);
      expect(again).toBe(after);
    });

    it('surfaces host errors as rejections', async () => {
      const { proxy } = await pair(preferShared);
      await expect(
        proxy.restore({ tick: 0, dt: 0.5, seed: 0, channels: {}, random: {}, modules: {} }),
      ).rejects.toThrow(/dt=0.5/);
    });
  });
}
