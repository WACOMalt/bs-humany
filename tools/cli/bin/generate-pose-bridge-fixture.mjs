#!/usr/bin/env node
/**
 * Write the pose-bridge fixtures the Rust reader is tested against.
 *
 *   pnpm generate:pose-bridge-fixture           # rewrite everything in apps/xr-viewer/fixtures
 *   pnpm generate:pose-bridge-fixture --check   # fail if any file is not what this would write
 *
 * Two implementations of one binary layout, in two languages, cannot share code. What they can
 * share is a file: this side writes it, that side reads it, and a test on each end pins the
 * numbers. If either side drifts from the layout -- stated once, in the header comments of
 * `packages/pose-bridge/src/codec.ts` -- the fixture stops matching and CI says so, which is the
 * same bargain every generated file in this repository makes.
 *
 * The contents are the ones the TypeScript unit test uses, so the two tests are literally
 * looking at the same bytes: three bones, three slots, five frames, a fixed clock.
 *
 * The panel's status travels as JSON rather than as a layout, and gets the same treatment:
 * `status.json` is the typed sample in `packages/session/src/vrStatusSample.ts`, which has to fill
 * every field of `PanelStatus` (`packages/pose-bridge/src/panel.ts`) to compile, written out as
 * it stands. The Rust side's status test parses that file, so a field renamed or dropped on this
 * side reaches the Rust test through the regenerated fixture, instead of reaching the headset as
 * a silent default.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { cliFlags } from '../lib/args.mjs';
import { emitOrCheck } from '../lib/generated.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT_DIR = join(ROOT, 'apps/xr-viewer/fixtures');
const { check } = cliFlags('generate-pose-bridge-fixture');

const jiti = createJiti(import.meta.url);
const { openPoseBridge, openMuscleBridge } = await jiti.import(
  join(ROOT, 'packages/pose-bridge/src/index.ts'),
);
const { PANEL_STATUS_SAMPLE } = await jiti.import(
  join(ROOT, 'packages/session/src/vrStatusSample.ts'),
);

/** Every file this writes into the fixtures directory, and so every file `--check` compares. */
const FILES = [
  'pose-bridge.bin',
  'pose-bridge.bin.json',
  'pose-bridge.bin-muscles',
  'status.json',
  'README.md',
];

const README =
  '# Fixtures\n\n' +
  '`pose-bridge.bin`, its sidecar and `pose-bridge.bin-muscles` are written by ' +
  '`pnpm generate:pose-bridge-fixture` from the TypeScript writer, and read by the Rust ' +
  "reader's tests.\n\n" +
  '`status.json` is the panel status with every field of the contract filled, written by the ' +
  'same generator from `packages/session/src/vrStatusSample.ts`, which is typed against ' +
  "`PanelStatus` in `packages/pose-bridge/src/panel.ts`. The Rust side's status test parses it " +
  'and pins a value from every field the headset reads.\n\n' +
  "None of them is edited by hand; the generator's `--check` is a CI gate.\n";

/** Everything, into `dir`: the rings under `pose-bridge.bin`, the status, and the README. */
function writeAll(dir) {
  writeRings(join(dir, 'pose-bridge.bin'));
  writeFileSync(join(dir, 'status.json'), `${JSON.stringify(PANEL_STATUS_SAMPLE, null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), README);
}

function writeRings(path) {
  const writer = openPoseBridge(
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
  // And the muscle bridge beside it: two bellies of three rings, four segments round, five
  // frames, ring r of unit u at y = u + r/2 rising a centimetre a frame.
  const muscles = openMuscleBridge(
    { units: 2, rings: 3, segments: 4 },
    { path: `${path}-muscles`, slots: 3 },
  );
  for (let t = 0; t < 5; t++) {
    const position = [];
    const orientation = [];
    const radius = [];
    for (let u = 0; u < 2; u++) {
      for (let r = 0; r < 3; r++) {
        position.push(0.1 * u, u + r / 2 + 0.01 * t, 0);
        orientation.push(0, 0, 0, 1);
        radius.push(0.05 + 0.001 * t);
      }
    }
    muscles.publish(t * 10, position, orientation, radius);
  }
  muscles.close();
}

// The bridge writers write to a path rather than return bytes, so everything is written into a
// scratch directory first and read back; the fixtures then go through the same emit or check as
// every other generated file. The scratch directory is gone before anything is compared, because a
// failed check exits on the spot.
const scratch = mkdtempSync(join(tmpdir(), 'pose-bridge-fixture-'));
let fresh;
try {
  writeAll(scratch);
  fresh = FILES.map((name) => [name, readFileSync(join(scratch, name))]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// A fixture that has moved means the layout or the status changed, and the Rust reader and its
// test change with it.
for (const [name, bytes] of fresh) {
  emitOrCheck({
    name: 'generate-pose-bridge-fixture',
    script: 'generate:pose-bridge-fixture',
    out: join(OUT_DIR, name),
    text: bytes,
    check,
  });
}
