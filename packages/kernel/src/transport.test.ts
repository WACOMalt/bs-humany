import { describe, expect, it } from 'vitest';
import { ChannelRegistry, sharedMemoryAvailable } from './channels.js';
import { type PortLike, Publisher, Receiver, layoutFor, packInto } from './transport.js';
import type { ChannelSpec } from './types.js';

/** Two ends of an in-process channel that behave like a Worker port pair. */
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

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const spec = (id: string, backing: 'shared' | 'local', n = 2): ChannelSpec => ({
  id,
  version: '1.0.0',
  layout: 'SoA',
  fields: [{ name: 'v', dtype: 'f64', components: 3 }],
  elementCount: n,
  mode: 'single-writer',
  backing,
});

describe('layout and packing', () => {
  it('lays channels out contiguously on 8-byte boundaries', () => {
    const r = new ChannelRegistry({ preferShared: false });
    const a = r.give(spec('a', 'local', 1), 'm');
    const b = r.give(spec('b', 'local', 5), 'm');
    const layout = layoutFor([a, b]);
    expect(layout.channels[0]?.byteOffset).toBe(0);
    expect((layout.channels[1]?.byteOffset ?? 1) % 8).toBe(0);
    expect(layout.totalBytes).toBeGreaterThanOrEqual(a.buffer.byteLength + b.buffer.byteLength);
    const target = new ArrayBuffer(layout.totalBytes);
    a.fields.v?.set([1, 2, 3]);
    packInto([a, b], layout, target);
    expect(
      new Float64Array(
        target,
        (layout.channels[0]?.byteOffset ?? 0) + (a.fieldOffsets.v ?? 0),
        3,
      )[1],
    ).toBe(2);
  });
});

describe('copy transport (the mobile path)', () => {
  it('delivers frames by transferring buffers and cycles them back', async () => {
    const r = new ChannelRegistry({ preferShared: false });
    const pose = r.give(spec('body.pose', 'shared'), 'physics');
    const [simPort, mainPort] = portPair();
    const publisher = new Publisher(simPort, [pose]);
    const receiver = new Receiver(mainPort);
    await tick();
    expect(receiver.isShared).toBe(false);

    for (let t = 1; t <= 6; t++) {
      pose.fields.v?.set([t, t * 10, t * 100], 0);
      publisher.publish(t);
      await tick();
      const frame = receiver.latest;
      expect(frame?.tick).toBe(t);
      const bytes = frame?.channels['body.pose'];
      expect(bytes).toBeDefined();
      if (!bytes) continue;
      const view = new Float64Array(bytes.buffer, bytes.byteOffset + (pose.fieldOffsets.v ?? 0), 3);
      expect(Array.from(view)).toEqual([t, t * 10, t * 100]);
      await tick(); // let the return message land
    }
    // Two buffers, six frames, nothing dropped: the pair cycled.
    expect(publisher.dropped).toBe(0);
    expect(receiver.frames).toBe(6);
  });

  it('drops rather than allocates when the main thread has not returned a buffer', async () => {
    const r = new ChannelRegistry({ preferShared: false });
    const pose = r.give(spec('body.pose', 'local'), 'physics');
    const [simPort, mainPort] = portPair();
    const publisher = new Publisher(simPort, [pose], { buffers: 2 });
    new Receiver(mainPort);
    await tick();
    // Publish three times without yielding: the third finds no free buffer.
    publisher.publish(1);
    publisher.publish(2);
    publisher.publish(3);
    expect(publisher.dropped).toBe(1);
  });

  it('does not let the publisher write into a buffer the receiver is reading', async () => {
    // After transfer the publisher's reference is detached; a second publish must use the other
    // buffer, so the frame the receiver holds stays intact.
    const r = new ChannelRegistry({ preferShared: false });
    const pose = r.give(spec('body.pose', 'local'), 'physics');
    const [simPort, mainPort] = portPair();
    const publisher = new Publisher(simPort, [pose]);
    const receiver = new Receiver(mainPort);
    await tick();
    pose.fields.v?.set([1, 1, 1], 0);
    publisher.publish(1);
    await tick();
    const first = receiver.latest?.channels['body.pose'];
    pose.fields.v?.set([2, 2, 2], 0);
    publisher.publish(2);
    // Without yielding, the receiver still holds frame 1 and it must still read 1.
    const view = first
      ? new Float64Array(first.buffer, first.byteOffset + (pose.fieldOffsets.v ?? 0), 3)
      : null;
    expect(view?.[0]).toBe(1);
  });
});

describe('shared transport', () => {
  it('lets the main thread read channels in place when SharedArrayBuffer exists', async () => {
    if (!sharedMemoryAvailable()) return;
    const r = new ChannelRegistry({ preferShared: true });
    const pose = r.give(spec('body.pose', 'shared'), 'physics');
    expect(pose.isShared).toBe(true);
    const [simPort, mainPort] = portPair();
    const publisher = new Publisher(simPort, [pose]);
    const receiver = new Receiver(mainPort, publisher.sharedBuffers());
    await tick();
    expect(publisher.isShared).toBe(true);
    expect(receiver.isShared).toBe(true);

    pose.fields.v?.set([7, 8, 9], 3);
    publisher.publish(42);
    await tick();
    const bytes = receiver.latest?.channels['body.pose'];
    expect(receiver.latest?.tick).toBe(42);
    const view = bytes
      ? new Float64Array(bytes.buffer, bytes.byteOffset + (pose.fieldOffsets.v ?? 0), 6)
      : null;
    expect(Array.from(view ?? [])).toEqual([0, 0, 0, 7, 8, 9]);
    // In place: a later write is visible without another publish.
    pose.fields.v?.set([1, 2, 3], 0);
    expect(view?.[0]).toBe(1);
    expect(publisher.dropped).toBe(0);
  });

  it('falls back to copying when any published channel is not shared', async () => {
    const r = new ChannelRegistry({ preferShared: true });
    const a = r.give(spec('a', 'shared'), 'm');
    const b = r.give(spec('b', 'local'), 'm');
    const [simPort, mainPort] = portPair();
    const publisher = new Publisher(simPort, [a, b]);
    new Receiver(mainPort);
    await tick();
    expect(publisher.isShared).toBe(false);
  });
});
