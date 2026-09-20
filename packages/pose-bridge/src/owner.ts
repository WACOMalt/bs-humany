/**
 * One publisher at a time on a bridge path.
 *
 * The bridge is single-writer by design: one ring of poses, one status, one command log. Two
 * publishers on the same path do not merely interleave two bodies into one stream -- they wipe
 * each other's files at startup and race on the temporary names the status is written through,
 * and the loser dies with an `ENOENT` on a rename, which is a baffling way to learn that the
 * real mistake was starting a second one.
 *
 * So a publisher claims the path first. The claim is a file beside the bridge holding the
 * process id; a claim whose process is gone is stale and is taken over, which is what makes this
 * survive a publisher that was killed rather than asked to stop.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Where a claim on `path` is kept. */
export const ownerPath = (path: string): string => `${path}-owner`;

/** Whether a process is still there. Signal 0 asks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM` means it exists and is somebody else's, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Who holds `path`, if anyone still does. */
export function bridgeOwner(path: string): number | undefined {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(ownerPath(path), 'utf8').trim(), 10);
  } catch {
    return undefined;
  }
  return Number.isInteger(pid) && pid !== process.pid && alive(pid) ? pid : undefined;
}

/**
 * Claim `path` for this process, or throw saying who has it.
 *
 * Releases the claim when the process ends, however it ends, so the next publisher does not have
 * to reason about a stale one.
 */
export function claimBridge(path: string, what = 'A publisher'): void {
  const held = bridgeOwner(path);
  if (held !== undefined) {
    throw new Error(
      `${what} is already publishing to ${path} as process ${held}. The bridge carries one ` +
        'body at a time, so two would wipe each other’s files and interleave two bodies ' +
        'into one stream. Stop that one, or pass --path to publish somewhere else.',
    );
  }
  writeFileSync(ownerPath(path), `${process.pid}\n`);
  const release = () => rmSync(ownerPath(path), { force: true });
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
}

/**
 * A name nothing else will write, for a file that is renamed into place.
 *
 * Writing to `<name>.tmp` and renaming is what makes a reader see a whole file or none; sharing
 * that one temporary name with another writer is what makes the rename fail.
 */
export const temporaryName = (path: string): string => `${path}.${process.pid}.tmp`;
