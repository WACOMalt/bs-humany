/**
 * The Node end of the bridges: a sink that writes with `fs`, the `open` conveniences the
 * publisher and the fixture generator use, and a grab reader over a file descriptor.
 */

import { closeSync, ftruncateSync, openSync, readSync, writeFileSync, writeSync } from 'node:fs';
import {
  type BridgeSink,
  type BridgeWrite,
  DEFAULT_GRAB_PATH,
  DEFAULT_PATH,
  DEFAULT_SLOTS,
  GRAB_BYTES,
  type GrabIntent,
  MuscleBridgeCodec,
  MuscleBridgeWriter,
  type MuscleShape,
  PoseBridgeCodec,
  type PoseBridgeOptions,
  PoseBridgeWriter,
  type RestPose,
  readGrabIntents,
} from './codec.js';

/** A file on disk -- tmpfs, in use -- written in place. */
export class NodeSink implements BridgeSink {
  private fd = -1;

  constructor(readonly path: string) {}

  create(bytes: number, initial: readonly BridgeWrite[]): void {
    this.fd = openSync(this.path, 'w+');
    ftruncateSync(this.fd, bytes);
    this.write(initial);
  }

  write(writes: readonly BridgeWrite[]): void {
    for (const w of writes) writeSync(this.fd, w.bytes, 0, w.bytes.byteLength, w.offset);
  }

  sidecar(suffix: string, text: string): void {
    writeFileSync(`${this.path}${suffix}`, text);
  }

  close(): void {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}

/** A pose writer on a file, with Node's clock. */
export function openPoseBridge(rest: RestPose, options: PoseBridgeOptions = {}): PoseBridgeWriter {
  const path = options.path ?? DEFAULT_PATH;
  const codec = new PoseBridgeCodec(
    rest,
    options.slots ?? DEFAULT_SLOTS,
    options.clock ?? (() => process.hrtime.bigint()),
  );
  return new PoseBridgeWriter(codec, new NodeSink(path));
}

/** A muscle writer on a file. */
export function openMuscleBridge(
  shape: MuscleShape,
  options: { path?: string; slots?: number } = {},
): MuscleBridgeWriter {
  const path = options.path ?? `${DEFAULT_PATH}-muscles`;
  return new MuscleBridgeWriter(
    new MuscleBridgeCodec(shape, options.slots ?? DEFAULT_SLOTS),
    new NodeSink(path),
  );
}

/**
 * The reading end of the grab channel, held by a Node simulation: two reads of 192 bytes a tick,
 * which is nothing at 500 Hz.
 */
export class GrabIntentReader {
  private readonly fd: number;
  private readonly first = new Uint8Array(GRAB_BYTES);
  private readonly second = new Uint8Array(GRAB_BYTES);

  private constructor(fd: number) {
    this.fd = fd;
  }

  /** Open for reading; undefined if there is no such file yet, which is not an error. */
  static open(path: string = DEFAULT_GRAB_PATH): GrabIntentReader | undefined {
    try {
      return new GrabIntentReader(openSync(path, 'r'));
    } catch {
      return undefined;
    }
  }

  read(): [GrabIntent | undefined, GrabIntent | undefined] {
    readSync(this.fd, this.first, 0, GRAB_BYTES, 0);
    readSync(this.fd, this.second, 0, GRAB_BYTES, 0);
    return readGrabIntents(this.first, this.second);
  }

  close(): void {
    closeSync(this.fd);
  }
}
