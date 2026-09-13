/**
 * Worker host and main-thread proxy -- M2.6.
 *
 * `WorkerHost` runs a `Kernel` behind a port. `KernelProxy` drives it from the other side. The
 * two speak a small typed protocol, and neither depends on the DOM: a test wires them over a
 * `MessageChannel`, the studio wires them over a `Worker`.
 *
 * The host publishes channel state after each batch of ticks through the transport, so the main
 * thread never reads kernel memory except through `Receiver`.
 */

import { Kernel, type KernelOptions, type KernelSnapshot } from './kernel.js';
import { type PortLike, Publisher, type ReceivedFrame, Receiver } from './transport.js';
import type { SimModule } from './types.js';

export type HostRequest =
  | {
      readonly kind: 'init';
      readonly requestId: number;
      readonly options: KernelOptions;
      readonly publish: readonly string[];
    }
  | { readonly kind: 'run'; readonly requestId: number; readonly ticks: number }
  | { readonly kind: 'snapshot'; readonly requestId: number }
  | { readonly kind: 'restore'; readonly requestId: number; readonly snapshot: KernelSnapshot }
  | { readonly kind: 'dispose'; readonly requestId: number };

/** `Omit` that distributes over a union, so each request variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type HostResponse =
  | {
      readonly kind: 'ready';
      readonly requestId: number;
      readonly order: readonly string[];
      readonly shared: Record<string, SharedArrayBuffer>;
    }
  | {
      readonly kind: 'done';
      readonly requestId: number;
      readonly tick: number;
      readonly stateHash: number;
    }
  | { readonly kind: 'snapshot'; readonly requestId: number; readonly snapshot: KernelSnapshot }
  | { readonly kind: 'error'; readonly requestId: number; readonly message: string };

/**
 * Runs the kernel. Construct it inside the worker with the module factory the worker knows how to
 * build; the main thread never sends code across.
 */
export class WorkerHost {
  readonly #control: PortLike;
  readonly #data: PortLike;
  readonly #modules: () => SimModule[];
  #kernel: Kernel | null = null;
  #publisher: Publisher | null = null;

  constructor(controlPort: PortLike, dataPort: PortLike, modules: () => SimModule[]) {
    this.#control = controlPort;
    this.#data = dataPort;
    this.#modules = modules;
    controlPort.onmessage = (event) => {
      void this.#handle(event.data as HostRequest);
    };
  }

  async #handle(request: HostRequest): Promise<void> {
    try {
      switch (request.kind) {
        case 'init': {
          const kernel = new Kernel(request.options);
          for (const m of this.#modules()) kernel.register(m);
          await kernel.init();
          this.#kernel = kernel;
          const storages = request.publish.map((id) => kernel.channels.storage(id));
          this.#publisher = new Publisher(this.#data, storages);
          const response: HostResponse = {
            kind: 'ready',
            requestId: request.requestId,
            order: kernel.order(),
            shared: this.#publisher.isShared ? this.#publisher.sharedBuffers() : {},
          };
          this.#control.postMessage(response);
          return;
        }
        case 'run': {
          const kernel = this.#require();
          kernel.run(request.ticks);
          this.#publisher?.publish(kernel.clock.tick);
          const response: HostResponse = {
            kind: 'done',
            requestId: request.requestId,
            tick: kernel.clock.tick,
            stateHash: kernel.stateHash(),
          };
          this.#control.postMessage(response);
          return;
        }
        case 'snapshot': {
          const response: HostResponse = {
            kind: 'snapshot',
            requestId: request.requestId,
            snapshot: this.#require().snapshot(),
          };
          this.#control.postMessage(response);
          return;
        }
        case 'restore': {
          const kernel = this.#require();
          kernel.restore(request.snapshot);
          this.#publisher?.publish(kernel.clock.tick);
          const response: HostResponse = {
            kind: 'done',
            requestId: request.requestId,
            tick: kernel.clock.tick,
            stateHash: kernel.stateHash(),
          };
          this.#control.postMessage(response);
          return;
        }
        case 'dispose': {
          this.#kernel?.dispose();
          this.#kernel = null;
          const response: HostResponse = {
            kind: 'done',
            requestId: request.requestId,
            tick: 0,
            stateHash: 0,
          };
          this.#control.postMessage(response);
          return;
        }
      }
    } catch (error) {
      const response: HostResponse = {
        kind: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      };
      this.#control.postMessage(response);
    }
  }

  #require(): Kernel {
    if (!this.#kernel) throw new Error('Kernel is not initialised in the host.');
    return this.#kernel;
  }
}

/** Drives a `WorkerHost` from the main thread. Every request resolves or rejects. */
export class KernelProxy {
  readonly #control: PortLike;
  readonly receiver: Receiver;
  readonly #pending = new Map<
    number,
    { resolve: (r: HostResponse) => void; reject: (e: Error) => void }
  >();
  #nextId = 1;
  #order: readonly string[] = [];

  constructor(controlPort: PortLike, dataPort: PortLike) {
    this.#control = controlPort;
    this.receiver = new Receiver(dataPort);
    controlPort.onmessage = (event) => {
      const response = event.data as HostResponse;
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      this.#pending.delete(response.requestId);
      if (response.kind === 'error') pending.reject(new Error(response.message));
      else pending.resolve(response);
    };
  }

  get order(): readonly string[] {
    return this.#order;
  }

  #send(request: DistributiveOmit<HostRequest, 'requestId'>): Promise<HostResponse> {
    const requestId = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#control.postMessage({ ...request, requestId } as HostRequest);
    });
  }

  async init(options: KernelOptions, publish: readonly string[]): Promise<void> {
    const r = await this.#send({ kind: 'init', options, publish });
    if (r.kind !== 'ready') throw new Error(`Unexpected response ${r.kind}`);
    this.#order = r.order;
    // On the shared path the receiver views the worker's buffers directly.
    if (Object.keys(r.shared).length > 0) this.receiver.adoptShared(r.shared);
  }

  async run(ticks: number): Promise<{ tick: number; stateHash: number }> {
    const r = await this.#send({ kind: 'run', ticks });
    if (r.kind !== 'done') throw new Error(`Unexpected response ${r.kind}`);
    return { tick: r.tick, stateHash: r.stateHash };
  }

  async snapshot(): Promise<KernelSnapshot> {
    const r = await this.#send({ kind: 'snapshot' });
    if (r.kind !== 'snapshot') throw new Error(`Unexpected response ${r.kind}`);
    return r.snapshot;
  }

  async restore(snapshot: KernelSnapshot): Promise<void> {
    await this.#send({ kind: 'restore', snapshot });
  }

  async dispose(): Promise<void> {
    await this.#send({ kind: 'dispose' });
  }

  get latestFrame(): ReceivedFrame | null {
    return this.receiver.latest;
  }
}
