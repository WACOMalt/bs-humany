/**
 * The channel registry -- M2.1 and M2.2.
 *
 * A channel is a named, versioned, typed SoA buffer with declared ownership. Modules acquire views
 * at `init` and keep them; nothing is looked up by string at step rate (spec section 9.2).
 *
 * ## Enforcement
 *
 * `reads`, `writes` and `accumulates` in a manifest are enforced, not documentary: a view is only
 * handed out for a declared access, and a single-writer channel refuses a second writer at
 * registration. This is what keeps module boundaries real over years of contribution by people --
 * and agents -- who have not read the whole codebase (ADR-004).
 *
 * JavaScript cannot make a typed array read-only, so a read view is the same memory as the write
 * view. The registry therefore also offers an **audit**: it hashes every channel a module did not
 * declare a write to before and after that module's step, and throws on a change. The audit is
 * for development and tests; it costs a pass over every buffer per module per tick and is off in
 * production.
 *
 * ## Backing
 *
 * `shared` channels are allocated in a `SharedArrayBuffer` when one is available, so a worker and
 * the main thread can share them without copying. When it is not -- no cross-origin isolation,
 * which the mobile floor (ADR-010) says cannot be assumed -- the channel lives in an `ArrayBuffer`
 * and the transport copies. Both paths are exercised by the tests.
 */

import type { ChannelSpec, ChannelView, Dtype, FieldView, ModuleManifest } from './types.js';

const BYTES: Record<Dtype, number> = { f64: 8, f32: 4, i32: 4, u32: 4, u8: 1 };

function makeView(
  dtype: Dtype,
  buffer: ArrayBufferLike,
  byteOffset: number,
  length: number,
): FieldView {
  switch (dtype) {
    case 'f64':
      return new Float64Array(buffer, byteOffset, length);
    case 'f32':
      return new Float32Array(buffer, byteOffset, length);
    case 'i32':
      return new Int32Array(buffer, byteOffset, length);
    case 'u32':
      return new Uint32Array(buffer, byteOffset, length);
    case 'u8':
      return new Uint8Array(buffer, byteOffset, length);
  }
}

/** True when a `SharedArrayBuffer` can be constructed in this context. */
export function sharedMemoryAvailable(): boolean {
  try {
    return typeof SharedArrayBuffer !== 'undefined' && new SharedArrayBuffer(8).byteLength === 8;
  } catch {
    return false;
  }
}

export interface ChannelStorage extends ChannelView {
  /** The whole channel's memory, for transport and snapshot. */
  readonly buffer: ArrayBufferLike;
  readonly isShared: boolean;
  /** Byte offset of each field within `buffer`. */
  readonly fieldOffsets: Readonly<Record<string, number>>;
  /** Capacity in elements. */
  readonly capacity: number;
}

/**
 * Allocate a channel's buffers.
 *
 * Every field is 8-byte aligned so an `f64` view is legal at any field boundary, and the live
 * count for a dynamic channel lives in the first 8 bytes.
 */
export function allocateChannel(spec: ChannelSpec, preferShared: boolean): ChannelStorage {
  if (spec.layout !== 'SoA') throw new Error(`Channel '${spec.id}': only SoA layout is supported.`);
  const capacity = spec.elementCount === 'dynamic' ? spec.capacity : spec.elementCount;
  if (capacity === undefined || !Number.isInteger(capacity) || capacity < 0) {
    throw new Error(
      `Channel '${spec.id}': a dynamic channel needs an integer 'capacity'; a fixed one needs an ` +
        `integer 'elementCount'. Got ${String(spec.elementCount)} / ${String(spec.capacity)}.`,
    );
  }
  if (spec.fields.length === 0) throw new Error(`Channel '${spec.id}' declares no fields.`);

  const names = new Set<string>();
  const fieldOffsets: Record<string, number> = {};
  let byteLength = 8; // count header
  for (const f of spec.fields) {
    if (names.has(f.name))
      throw new Error(`Channel '${spec.id}' declares field '${f.name}' twice.`);
    names.add(f.name);
    if (!Number.isInteger(f.components) || f.components < 1) {
      throw new Error(
        `Channel '${spec.id}' field '${f.name}': components must be a positive integer.`,
      );
    }
    fieldOffsets[f.name] = byteLength;
    const bytes = capacity * f.components * BYTES[f.dtype];
    byteLength += Math.ceil(bytes / 8) * 8;
  }

  const useShared = preferShared && spec.backing === 'shared' && sharedMemoryAvailable();
  const buffer: ArrayBufferLike = useShared
    ? new SharedArrayBuffer(byteLength)
    : new ArrayBuffer(byteLength);
  const header = new Uint32Array(buffer, 0, 1);
  const fields: Record<string, FieldView> = {};
  for (const f of spec.fields) {
    fields[f.name] = makeView(f.dtype, buffer, fieldOffsets[f.name] ?? 0, capacity * f.components);
  }
  if (spec.elementCount !== 'dynamic') header[0] = capacity;

  return {
    spec,
    fields,
    buffer,
    isShared: useShared,
    fieldOffsets,
    capacity,
    get count() {
      return header[0] ?? 0;
    },
    set count(value: number) {
      if (spec.elementCount !== 'dynamic') {
        throw new Error(`Channel '${spec.id}' has a fixed element count; 'count' is not writable.`);
      }
      if (!Number.isInteger(value) || value < 0 || value > capacity) {
        throw new Error(`Channel '${spec.id}': count ${value} is outside 0..${capacity}.`);
      }
      header[0] = value;
    },
  };
}

interface Registration {
  readonly storage: ChannelStorage;
  readonly giver: string;
  writer: string | null;
  readonly accumulators: Set<string>;
  readonly readers: Set<string>;
}

/**
 * Where channels live and who may touch them.
 *
 * Registration happens once, before any step, in a fixed order: every module's `gives` first, then
 * every module's declared accesses are checked against what exists.
 */
export class ChannelRegistry {
  readonly #channels = new Map<string, Registration>();
  readonly #preferShared: boolean;

  constructor(options: { preferShared?: boolean } = {}) {
    this.#preferShared = options.preferShared ?? true;
  }

  /** Register a channel on behalf of the module that gives it. */
  give(spec: ChannelSpec, giver: string): ChannelStorage {
    if (this.#channels.has(spec.id)) {
      const existing = this.#channels.get(spec.id);
      throw new Error(
        `Channel '${spec.id}' is given by both '${existing?.giver}' and '${giver}'. A channel has ` +
          'exactly one provider.',
      );
    }
    const storage = allocateChannel(spec, this.#preferShared);
    this.#channels.set(spec.id, {
      storage,
      giver,
      writer: null,
      accumulators: new Set(),
      readers: new Set(),
    });
    return storage;
  }

  /**
   * Check every access a manifest declares, and record the module as writer, accumulator or
   * reader. Throws with the offending channel named when a declaration cannot be honoured.
   */
  declare(manifest: ModuleManifest): void {
    for (const ref of manifest.writes) {
      const reg = this.#require(ref.id, manifest.id, 'write');
      if (reg.storage.spec.mode !== 'single-writer') {
        throw new Error(
          `Module '${manifest.id}' declares a write to '${ref.id}', which is an accumulator. ` +
            "Declare it under 'accumulates' instead: accumulators are added into, never assigned.",
        );
      }
      if (reg.writer !== null && reg.writer !== manifest.id) {
        throw new Error(
          `Channel '${ref.id}' already has writer '${reg.writer}'; module '${manifest.id}' cannot ` +
            'also write it. Single-writer channels have exactly one authoritative writer (ADR-004). ' +
            'If several modules must contribute, the channel should be an accumulator.',
        );
      }
      reg.writer = manifest.id;
    }
    for (const ref of manifest.accumulates) {
      const reg = this.#require(ref.id, manifest.id, 'accumulate');
      if (reg.storage.spec.mode !== 'accumulator') {
        throw new Error(
          `Module '${manifest.id}' declares an accumulation into '${ref.id}', which is a ` +
            'single-writer channel. Only accumulators accept contributions from several modules.',
        );
      }
      reg.accumulators.add(manifest.id);
    }
    for (const ref of manifest.reads) {
      const reg = this.#require(ref.id, manifest.id, 'read');
      reg.readers.add(manifest.id);
    }
  }

  #require(id: string, moduleId: string, access: string): Registration {
    const reg = this.#channels.get(id);
    if (!reg) {
      throw new Error(
        `Module '${moduleId}' declares a ${access} of channel '${id}', which no module gives. ` +
          `Known channels: ${[...this.#channels.keys()].sort().join(', ') || '(none)'}.`,
      );
    }
    return reg;
  }

  /** A view for a declared access, or an error naming what was not declared. */
  view(moduleId: string, id: string, access: 'read' | 'write' | 'accumulate'): ChannelView {
    const reg = this.#channels.get(id);
    if (!reg) throw new Error(`Channel '${id}' does not exist.`);
    const declared =
      access === 'read'
        ? reg.readers.has(moduleId) || reg.writer === moduleId || reg.accumulators.has(moduleId)
        : access === 'write'
          ? reg.writer === moduleId
          : reg.accumulators.has(moduleId);
    if (!declared) {
      throw new Error(
        `Module '${moduleId}' acquired a ${access} view of '${id}' without declaring it in its ` +
          `manifest. Declared ${access === 'read' ? 'reads' : access === 'write' ? 'writes' : 'accumulates'} ` +
          'are enforced, not documentary (ADR-004).',
      );
    }
    return reg.storage;
  }

  has(id: string): boolean {
    return this.#channels.has(id);
  }

  storage(id: string): ChannelStorage {
    const reg = this.#channels.get(id);
    if (!reg) throw new Error(`Channel '${id}' does not exist.`);
    return reg.storage;
  }

  writerOf(id: string): string | null {
    return this.#channels.get(id)?.writer ?? null;
  }

  ids(): string[] {
    return [...this.#channels.keys()].sort();
  }

  /** Zero every accumulator. Called at the start of each tick. */
  zeroAccumulators(): void {
    for (const reg of this.#channels.values()) {
      if (reg.storage.spec.mode !== 'accumulator') continue;
      for (const view of Object.values(reg.storage.fields)) view.fill(0);
    }
  }

  /**
   * Channels a module must not change during its step: everything it neither writes nor
   * accumulates into. Used by the audit.
   */
  undeclaredFor(moduleId: string): string[] {
    const out: string[] = [];
    for (const [id, reg] of this.#channels) {
      if (reg.writer === moduleId || reg.accumulators.has(moduleId)) continue;
      out.push(id);
    }
    return out.sort();
  }

  /** Cheap order-sensitive hash of a channel's bytes, for the audit and the determinism harness. */
  hash(id: string): number {
    const storage = this.storage(id);
    const bytes = new Uint8Array(storage.buffer, 0, storage.buffer.byteLength);
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i] ?? 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }
}
