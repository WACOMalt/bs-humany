import { describe, expect, it } from 'vitest';
import { ChannelRegistry, allocateChannel, sharedMemoryAvailable } from './channels.js';
import type { ChannelSpec, ModuleManifest } from './types.js';

const pose: ChannelSpec = {
  id: 'body.pose',
  version: '1.0.0',
  layout: 'SoA',
  fields: [
    { name: 'position', dtype: 'f64', components: 3 },
    { name: 'orientation', dtype: 'f64', components: 4 },
  ],
  elementCount: 4,
  mode: 'single-writer',
  backing: 'shared',
};

const torque: ChannelSpec = {
  id: 'actuation.jointTorque',
  version: '1.0.0',
  layout: 'SoA',
  fields: [{ name: 'torque', dtype: 'f64', components: 1 }],
  elementCount: 6,
  mode: 'accumulator',
  backing: 'local',
};

const contacts: ChannelSpec = {
  id: 'contact.manifolds',
  version: '1.0.0',
  layout: 'SoA',
  fields: [
    { name: 'point', dtype: 'f64', components: 3 },
    { name: 'impulse', dtype: 'f64', components: 1 },
    { name: 'pair', dtype: 'u32', components: 2 },
  ],
  elementCount: 'dynamic',
  capacity: 8,
  mode: 'single-writer',
  backing: 'local',
};

const manifest = (id: string, partial: Partial<Omit<ModuleManifest, 'id'>>): ModuleManifest => ({
  id,
  version: '1.0.0',
  phase: 'solve',
  dependsOn: [],
  reads: [],
  writes: [],
  accumulates: [],
  gives: [],
  ...partial,
});

describe('allocation', () => {
  it('lays out one typed view per field with the right length', () => {
    const c = allocateChannel(pose, false);
    expect(c.fields.position).toBeInstanceOf(Float64Array);
    expect(c.fields.position?.length).toBe(12);
    expect(c.fields.orientation?.length).toBe(16);
    expect(c.count).toBe(4);
    expect(c.capacity).toBe(4);
  });

  it('keeps every field 8-byte aligned so f64 views are legal after narrower fields', () => {
    const spec: ChannelSpec = {
      ...contacts,
      id: 'x',
      fields: [
        { name: 'flag', dtype: 'u8', components: 1 },
        { name: 'value', dtype: 'f64', components: 1 },
      ],
      elementCount: 3,
      capacity: undefined,
    };
    const c = allocateChannel(spec, false);
    expect((c.fieldOffsets.value ?? 0) % 8).toBe(0);
    expect(c.fields.value).toBeInstanceOf(Float64Array);
  });

  it('gives a dynamic channel a writable count bounded by capacity', () => {
    const c = allocateChannel(contacts, false);
    expect(c.count).toBe(0);
    c.count = 5;
    expect(c.count).toBe(5);
    expect(() => {
      c.count = 9;
    }).toThrow(/outside 0..8/);
  });

  it('refuses to change the count of a fixed channel', () => {
    const c = allocateChannel(pose, false);
    expect(() => {
      c.count = 2;
    }).toThrow(/fixed element count/);
  });

  it('refuses malformed specs with the channel named', () => {
    expect(() => allocateChannel({ ...contacts, capacity: undefined }, false)).toThrow(
      /'contact.manifolds'.*capacity/,
    );
    expect(() => allocateChannel({ ...pose, fields: [] }, false)).toThrow(/declares no fields/);
    expect(() =>
      allocateChannel(
        { ...pose, fields: [pose.fields[0] as never, pose.fields[0] as never] },
        false,
      ),
    ).toThrow(/twice/);
  });

  it('backs a shared channel with SharedArrayBuffer when available, ArrayBuffer otherwise', () => {
    const shared = allocateChannel(pose, true);
    expect(shared.isShared).toBe(sharedMemoryAvailable());
    // Both paths are first-class (ADR-010): the fallback must work identically.
    const local = allocateChannel(pose, false);
    expect(local.isShared).toBe(false);
    expect(local.buffer).toBeInstanceOf(ArrayBuffer);
    local.fields.position?.set([1, 2, 3], 0);
    expect(local.fields.position?.[2]).toBe(3);
  });
});

describe('ownership', () => {
  it('rejects two providers of one channel', () => {
    const r = new ChannelRegistry();
    r.give(pose, 'physics');
    expect(() => r.give(pose, 'other')).toThrow(/given by both 'physics' and 'other'/);
  });

  it('rejects a second writer of a single-writer channel, naming both', () => {
    const r = new ChannelRegistry();
    r.give(pose, 'physics');
    r.declare(manifest('physics', { writes: [{ id: 'body.pose', version: '^1' }] }));
    expect(() =>
      r.declare(manifest('rogue', { writes: [{ id: 'body.pose', version: '^1' }] })),
    ).toThrow(/already has writer 'physics'; module 'rogue'/);
  });

  it('accepts any number of accumulators', () => {
    const r = new ChannelRegistry();
    r.give(torque, 'physics');
    for (const id of ['nerve', 'motor-test', 'grab']) {
      r.declare(manifest(id, { accumulates: [{ id: torque.id, version: '^1' }] }));
    }
    expect(r.writerOf(torque.id)).toBeNull();
  });

  it('refuses a write declared on an accumulator, and an accumulate on a single-writer', () => {
    const r = new ChannelRegistry();
    r.give(pose, 'physics');
    r.give(torque, 'physics');
    expect(() => r.declare(manifest('a', { writes: [{ id: torque.id, version: '^1' }] }))).toThrow(
      /is an accumulator/,
    );
    expect(() =>
      r.declare(manifest('b', { accumulates: [{ id: pose.id, version: '^1' }] })),
    ).toThrow(/single-writer channel/);
  });

  it('names the missing channel and lists what exists when a declaration dangles', () => {
    const r = new ChannelRegistry();
    r.give(pose, 'physics');
    expect(() => r.declare(manifest('m', { reads: [{ id: 'body.poze', version: '^1' }] }))).toThrow(
      /'body.poze', which no module gives.*Known channels: body.pose/,
    );
  });
});

describe('access enforcement', () => {
  it('hands out views only for declared accesses', () => {
    const r = new ChannelRegistry();
    r.give(pose, 'physics');
    r.give(torque, 'physics');
    r.declare(
      manifest('physics', {
        writes: [{ id: pose.id, version: '^1' }],
        reads: [{ id: torque.id, version: '^1' }],
      }),
    );
    r.declare(manifest('sensor', { reads: [{ id: pose.id, version: '^1' }] }));

    expect(() => r.view('physics', pose.id, 'write')).not.toThrow();
    expect(() => r.view('sensor', pose.id, 'read')).not.toThrow();
    expect(() => r.view('sensor', pose.id, 'write')).toThrow(/without declaring it/);
    expect(() => r.view('sensor', torque.id, 'read')).toThrow(/without declaring it/);
    expect(() => r.view('physics', torque.id, 'accumulate')).toThrow(/without declaring it/);
  });

  it('lets a writer read its own channel without a separate read declaration', () => {
    const r = new ChannelRegistry();
    r.give(pose, 'physics');
    r.declare(manifest('physics', { writes: [{ id: pose.id, version: '^1' }] }));
    expect(() => r.view('physics', pose.id, 'read')).not.toThrow();
  });
});

describe('accumulator semantics', () => {
  it('sums contributions from several writers in order and zeroes each tick', () => {
    // The extension point for all future actuation (spec 10.3): a nerve module and a manual
    // motor tool contribute forces without knowing about each other.
    const r = new ChannelRegistry();
    const c = r.give(torque, 'physics');
    r.declare(manifest('a', { accumulates: [{ id: torque.id, version: '^1' }] }));
    r.declare(manifest('b', { accumulates: [{ id: torque.id, version: '^1' }] }));

    const va = r.view('a', torque.id, 'accumulate').fields.torque as Float64Array;
    const vb = r.view('b', torque.id, 'accumulate').fields.torque as Float64Array;

    r.zeroAccumulators();
    va[0] = (va[0] ?? 0) + 1.5;
    vb[0] = (vb[0] ?? 0) + 2.25;
    va[3] = (va[3] ?? 0) - 4;
    expect(c.fields.torque?.[0]).toBe(3.75);
    expect(c.fields.torque?.[3]).toBe(-4);

    r.zeroAccumulators();
    expect(Array.from(c.fields.torque as Float64Array)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('does not zero single-writer channels', () => {
    const r = new ChannelRegistry();
    const c = r.give(pose, 'physics');
    c.fields.position?.set([9, 9, 9], 0);
    r.zeroAccumulators();
    expect(c.fields.position?.[0]).toBe(9);
  });
});

describe('audit support', () => {
  it('lists the channels a module must leave untouched', () => {
    const r = new ChannelRegistry();
    r.give(pose, 'physics');
    r.give(torque, 'physics');
    r.give(contacts, 'physics');
    r.declare(
      manifest('physics', {
        writes: [
          { id: pose.id, version: '^1' },
          { id: contacts.id, version: '^1' },
        ],
      }),
    );
    r.declare(
      manifest('nerve', {
        accumulates: [{ id: torque.id, version: '^1' }],
        reads: [{ id: pose.id, version: '^1' }],
      }),
    );
    expect(r.undeclaredFor('physics')).toEqual([torque.id]);
    expect(r.undeclaredFor('nerve')).toEqual([pose.id, contacts.id]);
  });

  it('hashes bytes so any change is visible', () => {
    const r = new ChannelRegistry();
    const c = r.give(pose, 'physics');
    const before = r.hash(pose.id);
    c.fields.orientation?.set([0, 0, 0, 1], 0);
    expect(r.hash(pose.id)).not.toBe(before);
    expect(r.hash(pose.id)).toBe(r.hash(pose.id));
  });
});
