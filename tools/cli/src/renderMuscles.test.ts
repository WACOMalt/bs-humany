/**
 * The muscle-data writer, held to the formatter it has to agree with.
 *
 * Every generator's `--check` compares the file it would write with the committed one byte for
 * byte, and `pnpm lint` holds the committed one to `biome format`. So the writer has to produce
 * exactly what Biome would, or the two gates disagree forever: one rewrites the file and the other
 * then calls it stale. The landmark-style sets (neck, girdle, thorax) used to write a one-point
 * path on one line however long its site id was, which is right until the id is long enough to
 * push the line past the width; the MyoSuite writer knew where Biome breaks it and that one did
 * not. Both go through `renderPath` now, and these cases are the ones either side of the break.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMuscleGroups } from '../lib/renderMuscles.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** A region file around one group whose single unit has the given path. */
function regionFile(path: readonly string[]): string {
  const body = renderMuscleGroups([
    {
      id: 'probe_r',
      displayName: 'Probe, right',
      source: "gray('Probe')",
      units: [
        {
          id: 'probe_r',
          displayName: 'Probe, right',
          origin: 'probe_origin_r_somewhere',
          insertion: 'probe_insertion_r_somewhere_else',
          path,
          parameters: {
            maxIsometricForce: 100,
            optimalFiberLength: 0.1,
            tendonSlackLength: 0.05,
          },
          source: "gray('Probe')",
        },
      ],
    },
  ]);
  return `const gray = (muscle: string) => muscle;\n\nexport const PROBE = [\n${body}\n];\n`;
}

/** What `biome format` makes of `text`, as the repository's configuration has it. */
function biomeFormat(text: string): string {
  const run = spawnSync('pnpm', ['exec', 'biome', 'format', '--stdin-file-path', 'x.ts'], {
    cwd: ROOT,
    input: text,
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

/** A site id of exactly `length` characters. */
const siteOf = (length: number) => `site_${'x'.repeat(length - 5)}`;

// Each case starts Biome through pnpm, which takes a second or more on a loaded machine.
describe('renderMuscleGroups', { timeout: 30_000 }, () => {
  it('writes a path with one 70-character site id as biome format would', () => {
    const text = regionFile([siteOf(70)]);
    expect(biomeFormat(text)).toBe(text);
  });

  // 62 characters is where the element still fits on its own line but the whole path on one line
  // does not: the array breaks and the object inside it does not.
  it('breaks a one-point path whose one-line form is past the width, and nothing else', () => {
    const text = regionFile([siteOf(62)]);
    expect(biomeFormat(text)).toBe(text);
  });

  it.each([
    ['a short point on one line', [siteOf(20)]],
    ['several points one to a line', [siteOf(20), siteOf(30), siteOf(70)]],
    ['no points as an empty pair', []],
  ])('writes %s', (_, path) => {
    const text = regionFile(path);
    expect(biomeFormat(text)).toBe(text);
  });
});
