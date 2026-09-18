#!/usr/bin/env node
/**
 * Write the pose-bridge fixture the Rust reader is tested against.
 *
 *   pnpm generate:pose-bridge-fixture           # rewrite apps/xr-viewer/fixtures/pose-bridge.bin
 *   pnpm generate:pose-bridge-fixture --check   # fail if the file is not what this would write
 *
 * Two implementations of one binary layout, in two languages, cannot share code. What they can
 * share is a file: this side writes it, that side reads it, and a test on each end pins the
 * numbers. If either side drifts from the layout in `packages/pose-bridge/src/index.ts`, the
 * fixture stops matching and CI says so -- which is the same bargain every generated file in
 * this repository makes.
 *
 * The contents are the ones the TypeScript unit test uses, so the two tests are literally
 * looking at the same bytes: three bones, three slots, five frames, a fixed clock.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT_DIR = join(ROOT, 'apps/xr-viewer/fixtures');
const OUT = join(OUT_DIR, 'pose-bridge.bin');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { PoseBridgeWriter } = await jiti.import(join(ROOT, 'packages/pose-bridge/src/index.ts'));

function write(path) {
  const writer = PoseBridgeWriter.open(
    {
      bones: ['pelvis', 'femur_r', 'tibia_r'],
      position: [0, 0.9, 0, 0.1, 0.8, 0, 0.1, 0.4, 0],
      orientation: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      datasetScale: 1.7 / 1.6963,
    },
    { path, slots: 3, clock: () => 1_000_000_000n },
  );
  for (let t = 0; t < 5; t++) {
    writer.publish(
      t * 10,
      t * 0.01,
      [0, 0.9 - t * 0.01, 0, 0.1, 0.8, 0, 0.1, 0.4, t],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    );
  }
  writer.close();
}

if (check) {
  const dir = mkdtempSync(join(tmpdir(), 'pose-bridge-fixture-'));
  try {
    write(join(dir, 'pose-bridge.bin'));
    for (const name of ['pose-bridge.bin', 'pose-bridge.bin.json']) {
      const fresh = readFileSync(join(dir, name));
      const committed = readFileSync(join(OUT_DIR, name));
      if (!fresh.equals(committed)) {
        console.error(
          `generate-pose-bridge-fixture: ${relative(ROOT, join(OUT_DIR, name))} is not what the ` +
            'generator would write.\n  Run `pnpm generate:pose-bridge-fixture`. If the layout ' +
            'changed, the Rust reader and its test change with it.',
        );
        process.exit(1);
      }
    }
    console.log('generate-pose-bridge-fixture: ok.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  write(OUT);
  writeFileSync(
    join(OUT_DIR, 'README.md'),
    '# Fixtures\n\n`pose-bridge.bin` and its sidecar are written by ' +
      '`pnpm generate:pose-bridge-fixture` from the TypeScript writer, and read by the Rust ' +
      "reader's tests. Neither is edited by hand; the generator's `--check` is a CI gate.\n",
  );
  console.log(`generate-pose-bridge-fixture: wrote ${relative(ROOT, OUT)} and its sidecar.`);
}
