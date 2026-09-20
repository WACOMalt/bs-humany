/**
 * One publisher a path. The bridge is a single ring with a single status beside it, and two
 * publishers on one path wipe each other's files at startup and race on the name the status is
 * renamed through -- which the loser meets as an `ENOENT` on a rename, a long way from the
 * mistake that caused it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeOwner, claimBridge, ownerPath, temporaryName } from './owner.js';

const made: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-humany-owner-'));
  made.push(dir);
  return join(dir, 'pose');
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a claim on a bridge path', () => {
  it('is free until somebody takes it, and then says who has it', () => {
    const path = scratch();
    expect(bridgeOwner(path)).toBeUndefined();
    claimBridge(path);
    // This process holds it, and asking from this process reads as free rather than as a
    // deadlock against itself.
    expect(bridgeOwner(path)).toBeUndefined();

    // Somebody else, and alive: process 1 is always there.
    writeFileSync(ownerPath(path), '1\n');
    expect(bridgeOwner(path)).toBe(1);
    expect(() => claimBridge(path, 'A showcase')).toThrow(/already publishing/);
  });

  it('takes over from a publisher that was killed rather than asked to stop', () => {
    const path = scratch();
    // A pid that cannot be running: the highest a Linux pid may be, plus one.
    writeFileSync(ownerPath(path), '4194305\n');
    expect(bridgeOwner(path)).toBeUndefined();
    expect(() => claimBridge(path)).not.toThrow();
  });

  it('gives each process a temporary name of its own', () => {
    // Two publishers writing one status renamed the same temporary file; whichever renamed
    // second found it gone. The name carries the process id so there is nothing to share.
    expect(temporaryName('/dev/shm/pose-status.json')).toContain(String(process.pid));
    expect(temporaryName('/dev/shm/pose-status.json')).not.toBe('/dev/shm/pose-status.json.tmp');
  });
});
