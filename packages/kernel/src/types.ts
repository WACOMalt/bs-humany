/**
 * Kernel contracts -- spec section 10, ADR-004.
 *
 * All simulation advances on a fixed timestep. Modules run in declared phases in a deterministic
 * order. Every channel has exactly one authoritative writer, except accumulators, which any number
 * of modules add into and which are zeroed each tick. Modules never hold references to other
 * modules: they see channels, a clock and a seeded random stream, nothing else.
 */

import type { Prng } from './prng.js';

/** Fixed phase order, every tick. `render` is off the fixed clock and is not run by the kernel. */
export const PHASES = ['input', 'sense', 'control', 'actuate', 'solve', 'post'] as const;
export type Phase = (typeof PHASES)[number];

export type Dtype = 'f64' | 'f32' | 'i32' | 'u32' | 'u8';

export interface FieldSpec {
  readonly name: string;
  readonly dtype: Dtype;
  /** Scalars per element: 3 for a position, 4 for a quaternion, 1 for a flag. */
  readonly components: number;
}

export interface ChannelSpec {
  /** `body.pose`, `actuation.jointTorque`. */
  readonly id: string;
  readonly version: string;
  readonly layout: 'SoA';
  readonly fields: readonly FieldSpec[];
  /**
   * Fixed element count, or `'dynamic'` with a `capacity`. A dynamic channel carries a live
   * `count` alongside its buffers; contact manifolds are the Phase 1 example.
   */
  readonly elementCount: number | 'dynamic';
  readonly capacity?: number | undefined;
  readonly mode: 'single-writer' | 'accumulator';
  /**
   * `shared` asks for a `SharedArrayBuffer` so the main thread can read without copying. Honoured
   * only where cross-origin isolation exists; otherwise the channel is backed by an `ArrayBuffer`
   * and the transport copies. Both paths are first-class (ADR-010).
   */
  readonly backing: 'shared' | 'local';
}

export interface ChannelRef {
  readonly id: string;
  /** Semver range the module was written against. */
  readonly version: string;
}

export interface ModuleRef {
  readonly id: string;
  readonly version: string;
}

export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly phase: Phase;
  /** Tie-break within a phase after dependency order. Lower runs first. */
  readonly order?: number;
  /** 1 runs every tick; 10 runs every tenth. */
  readonly rateDivisor?: number;
  readonly dependsOn: readonly ModuleRef[];
  /** Declared and enforced. A module that touches an undeclared channel fails at init. */
  readonly reads: readonly ChannelRef[];
  readonly writes: readonly ChannelRef[];
  readonly accumulates: readonly ChannelRef[];
  /** Channels this module creates. */
  readonly gives: readonly ChannelSpec[];
}

/** Typed-array views over one field of a channel. */
export type FieldView = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array;

export interface ChannelView {
  readonly spec: ChannelSpec;
  /** One view per field, keyed by field name, each `elementCount * components` long. */
  readonly fields: Readonly<Record<string, FieldView>>;
  /** Live element count. Equals `elementCount` for fixed channels; writable for dynamic ones. */
  count: number;
}

export interface ModuleInitContext {
  /** Acquire a read view. Throws unless the manifest declares the read. */
  read(channelId: string): ChannelView;
  /** Acquire a write view. Throws unless the manifest declares the write. */
  write(channelId: string): ChannelView;
  /** Acquire an accumulator view. Throws unless the manifest declares it. */
  accumulate(channelId: string): ChannelView;
  /** Deterministic random stream derived from the session seed and the module id. */
  readonly random: Prng;
  readonly dt: number;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface ModuleStepContext {
  readonly tick: number;
  readonly dt: number;
  readonly simTime: number;
}

export interface SimModule {
  readonly manifest: ModuleManifest;
  init(ctx: ModuleInitContext): Promise<void> | void;
  /** Must not allocate, must not await, must not touch wall-clock or Math.random. */
  step(ctx: ModuleStepContext): void;
  reset?(ctx: ModuleInitContext): void;
  dispose?(): void;
}
