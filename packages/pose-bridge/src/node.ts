/**
 * The Node end of the bridges: a sink that writes with `fs`, the `open` conveniences the
 * publisher and the fixture generator use, and a grab reader over a file descriptor.
 */

import {
  closeSync,
  ftruncateSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
  grabWritten,
  readGrabIntents,
} from './codec.js';
import { temporaryName } from './owner.js';

/**
 * A file on disk -- tmpfs, in use -- written in place.
 *
 * Created as a new file every time rather than truncated: built whole under a temporary name,
 * header and rest table included, and renamed over the old one. The viewer maps the bridge it
 * follows, and truncating a file under a live mapping is a SIGBUS in the viewer as soon as it
 * touches a page that is gone. A rename leaves the old inode, whole, with whoever still has it
 * mapped until they let go, and the file the name points at is a complete bridge from the moment
 * it has the name. The bytes are the same either way, so the fixture does not change.
 */
export class NodeSink implements BridgeSink {
  private fd = -1;

  constructor(readonly path: string) {}

  create(bytes: number, initial: readonly BridgeWrite[]): void {
    this.close();
    const temporary = temporaryName(this.path);
    this.fd = openSync(temporary, 'w+');
    ftruncateSync(this.fd, bytes);
    this.write(initial);
    renameSync(temporary, this.path);
  }

  write(writes: readonly BridgeWrite[]): void {
    for (const w of writes) writeSync(this.fd, w.bytes, 0, w.bytes.byteLength, w.offset);
  }

  /** Renamed into place like the ring, so a reader never reads half a list of bones. */
  sidecar(suffix: string, text: string): void {
    const path = `${this.path}${suffix}`;
    const temporary = temporaryName(path);
    writeFileSync(temporary, text);
    renameSync(temporary, path);
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
  /**
   * The renderer's slot-write count as of the last `read`, from the same bytes the hands were
   * parsed from: the heartbeat a watchdog holds against its own clock, since a renderer that has
   * gone leaves its last slots behind it and they may still say a hand is squeezing.
   */
  written = 0n;

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
    this.written = grabWritten(this.second);
    return readGrabIntents(this.first, this.second);
  }

  close(): void {
    closeSync(this.fd);
  }
}
