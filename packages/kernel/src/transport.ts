/**
 * Transport between the simulation thread and the main thread -- ADR-008, ADR-010.
 *
 * The kernel runs in a Web Worker. The main thread owns rendering and needs the latest channel
 * state each frame. Two ways to get it there, both first-class:
 *
 *  - **Shared.** With cross-origin isolation, `shared` channels already live in a
 *    `SharedArrayBuffer`; the main thread reads them in place. A tick counter in shared memory,
 *    updated with `Atomics`, tells the reader which tick it is looking at.
 *  - **Copy.** Without isolation -- the mobile case -- the worker copies the published channels
 *    into a transferable `ArrayBuffer` and posts it; the buffer's ownership moves, so nothing is
 *    duplicated. Two buffers alternate so the worker never writes into one the main thread is
 *    reading, and the main thread returns each buffer when it is done with it.
 *
 * The transport is defined against the smallest message-port surface -- `postMessage` and
 * `onmessage` -- so the same code runs over a real `Worker`, a `MessageChannel` in a test, or any
 * future remote link (ADR-002's "backend later" path reduces to swapping this).
 */

import type { ChannelStorage } from './channels.js';

/**
 * The message-port surface both ends are written against.
 *
 * The transfer list is typed as `ArrayBuffer[]` rather than the DOM's `Transferable[]`: the kernel
 * compiles without DOM types, and buffers are the only thing this transport ever transfers. Both
 * `Worker.postMessage` and Node's `MessagePort.postMessage` accept it.
 */
export interface PortLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Layout of one channel within a published copy. */
export interface PublishedChannel {
  readonly id: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface PublishedLayout {
  readonly channels: readonly PublishedChannel[];
  readonly totalBytes: number;
}

/** Compute where each channel sits in one contiguous copy buffer. */
export function layoutFor(storages: readonly ChannelStorage[]): PublishedLayout {
  const channels: PublishedChannel[] = [];
  let offset = 0;
  for (const s of storages) {
    channels.push({ id: s.spec.id, byteOffset: offset, byteLength: s.buffer.byteLength });
    offset += Math.ceil(s.buffer.byteLength / 8) * 8;
  }
  return { channels, totalBytes: offset };
}

/** Copy every listed channel into `target` at its laid-out offset. Allocation-free. */
export function packInto(
  storages: readonly ChannelStorage[],
  layout: PublishedLayout,
  target: ArrayBuffer,
): void {
  const dst = new Uint8Array(target);
  for (let i = 0; i < storages.length; i++) {
    const s = storages[i] as ChannelStorage;
    const entry = layout.channels[i] as PublishedChannel;
    dst.set(new Uint8Array(s.buffer, 0, s.buffer.byteLength), entry.byteOffset);
  }
}

// ---------------------------------------------------------------------------------------------
// Publisher side (simulation thread)
// ---------------------------------------------------------------------------------------------

export type PublishMessage =
  | { readonly kind: 'layout'; readonly layout: PublishedLayout; readonly shared: boolean }
  | { readonly kind: 'frame'; readonly tick: number; readonly buffer: ArrayBuffer }
  | { readonly kind: 'shared-frame'; readonly tick: number };

export type ReturnMessage = { readonly kind: 'return'; readonly buffer: ArrayBuffer };

/**
 * Publishes channel state from the simulation thread.
 *
 * Chooses the shared path when every published channel is shared-backed, and the copy path
 * otherwise. Mixed sets fall back to copying, which is always correct.
 */
export class Publisher {
  readonly #port: PortLike;
  readonly #storages: readonly ChannelStorage[];
  readonly #layout: PublishedLayout;
  readonly #shared: boolean;
  readonly #free: ArrayBuffer[] = [];
  #dropped = 0;

  constructor(
    port: PortLike,
    storages: readonly ChannelStorage[],
    options: { buffers?: number } = {},
  ) {
    this.#port = port;
    this.#storages = storages;
    this.#layout = layoutFor(storages);
    this.#shared = storages.length > 0 && storages.every((s) => s.isShared);
    if (!this.#shared) {
      const count = options.buffers ?? 2;
      for (let i = 0; i < count; i++) this.#free.push(new ArrayBuffer(this.#layout.totalBytes));
    }
    port.onmessage = (event) => {
      const data = event.data as ReturnMessage;
      if (data && data.kind === 'return') this.#free.push(data.buffer);
    };
    const layoutMessage: PublishMessage = {
      kind: 'layout',
      layout: this.#layout,
      shared: this.#shared,
    };
    port.postMessage(layoutMessage);
  }

  get isShared(): boolean {
    return this.#shared;
  }

  /** Frames skipped because the main thread had not returned a buffer. */
  get dropped(): number {
    return this.#dropped;
  }

  /** The shared buffers themselves, for the receiver to view directly. */
  sharedBuffers(): Record<string, SharedArrayBuffer> {
    const out: Record<string, SharedArrayBuffer> = {};
    for (const s of this.#storages) out[s.spec.id] = s.buffer as SharedArrayBuffer;
    return out;
  }

  /**
   * Publish the current state as `tick`.
   *
   * On the copy path, if no buffer is free the frame is dropped and counted: the alternative is
   * to allocate, and allocation in the step loop is forbidden (CONTRIBUTING rule 9). A dropped
   * frame means the renderer is behind, which is information, not an error.
   */
  publish(tick: number): void {
    if (this.#shared) {
      const message: PublishMessage = { kind: 'shared-frame', tick };
      this.#port.postMessage(message);
      return;
    }
    const buffer = this.#free.pop();
    if (!buffer) {
      this.#dropped++;
      return;
    }
    packInto(this.#storages, this.#layout, buffer);
    const message: PublishMessage = { kind: 'frame', tick, buffer };
    this.#port.postMessage(message, [buffer]);
  }
}

// ---------------------------------------------------------------------------------------------
// Receiver side (main thread)
// ---------------------------------------------------------------------------------------------

/** A received frame: byte views of each channel, valid until the next frame replaces it. */
export interface ReceivedFrame {
  readonly tick: number;
  readonly channels: Readonly<Record<string, Uint8Array>>;
}

/**
 * Receives published state on the main thread.
 *
 * `latest` always holds the most recent frame; on the copy path the previous buffer is returned
 * to the publisher when a new one arrives, which is what keeps the pair of buffers cycling.
 */
export class Receiver {
  readonly #port: PortLike;
  #layout: PublishedLayout | null = null;
  #shared = false;
  #sharedBuffers: Record<string, SharedArrayBuffer> = {};
  #current: ArrayBuffer | null = null;
  #latest: ReceivedFrame | null = null;
  #frames = 0;
  #onFrame: ((frame: ReceivedFrame) => void) | null = null;

  constructor(port: PortLike, sharedBuffers: Record<string, SharedArrayBuffer> = {}) {
    this.#port = port;
    this.#sharedBuffers = sharedBuffers;
    port.onmessage = (event) => this.#handle(event.data as PublishMessage);
  }

  get latest(): ReceivedFrame | null {
    return this.#latest;
  }

  get frames(): number {
    return this.#frames;
  }

  get isShared(): boolean {
    return this.#shared;
  }

  set onFrame(handler: ((frame: ReceivedFrame) => void) | null) {
    this.#onFrame = handler;
  }

  /**
   * Attach the publisher's shared buffers, so shared frames can be viewed in place.
   *
   * On the shared path the buffers arrive out of band -- the host hands them over in its `ready`
   * response, since a `SharedArrayBuffer` is cloned by reference through `postMessage` -- so the
   * receiver learns about them after construction.
   */
  adoptShared(buffers: Record<string, SharedArrayBuffer>): void {
    this.#sharedBuffers = buffers;
  }

  #handle(message: PublishMessage): void {
    switch (message.kind) {
      case 'layout':
        this.#layout = message.layout;
        this.#shared = message.shared;
        return;
      case 'shared-frame': {
        const channels: Record<string, Uint8Array> = {};
        for (const [id, buffer] of Object.entries(this.#sharedBuffers)) {
          channels[id] = new Uint8Array(buffer, 0, buffer.byteLength);
        }
        this.#latest = { tick: message.tick, channels };
        this.#frames++;
        this.#onFrame?.(this.#latest);
        return;
      }
      case 'frame': {
        if (!this.#layout) throw new Error('Frame received before layout.');
        // Hand the previous buffer back before adopting the new one.
        if (this.#current) {
          const ret: ReturnMessage = { kind: 'return', buffer: this.#current };
          this.#port.postMessage(ret, [this.#current]);
        }
        this.#current = message.buffer;
        const channels: Record<string, Uint8Array> = {};
        for (const c of this.#layout.channels) {
          channels[c.id] = new Uint8Array(message.buffer, c.byteOffset, c.byteLength);
        }
        this.#latest = { tick: message.tick, channels };
        this.#frames++;
        this.#onFrame?.(this.#latest);
        return;
      }
    }
  }
}
