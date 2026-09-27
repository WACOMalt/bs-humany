/**
 * The trainer's flags, read the way `train-nerves.mjs` reads them.
 *
 * The flag a run most needs -- `--resume` -- was the one refused as unknown, because it was read
 * by a route that never registered it; the studio's Resume and the terminal's both stopped
 * working together, and nothing failed until a person tried. So the argv the dashboard builds is
 * checked here against the table, as is everything the help promises.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAIN_FLAGS, formatHelp, parse } from '../bin/flags.mjs';

const ROOT = join(import.meta.dirname, '../../..');

/** Parse against the trainer's table and say only what was wrong. */
function problems(argv: string[]): { errors: string[]; unknown: string[] } {
  const { errors, unknown } = parse(argv, TRAIN_FLAGS);
  return { errors, unknown };
}
const clean = { errors: [], unknown: [] };

describe("train-nerves' flags", () => {
  it('accepts the argv the dashboard builds, resumed or not', () => {
    const argv = [
      '--recipe',
      'p',
      '--generations',
      '600',
      '--population',
      '64',
      '--workers',
      '16',
      '--seconds',
      '6',
      '--seeds',
      '2',
    ];
    expect(problems(argv)).toEqual(clean);
    expect(problems([...argv, '--resume'])).toEqual(clean);
    const { values, given } = parse([...argv, '--resume'], TRAIN_FLAGS);
    expect(values).toMatchObject({ recipe: 'p', generations: 600, population: 64, resume: true });
    expect(given.has('resume')).toBe(true);
  });

  it('knows every flag the dashboard source passes to the trainer', () => {
    // Read from the source rather than copied, so a flag added there and not here fails here.
    const source = readFileSync(join(ROOT, 'tools/train/bin/dashboard.mjs'), 'utf8');
    const start = source.indexOf("join(ROOT, 'tools/train/bin/train-nerves.mjs')");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf('spawn(', start));
    const passed = [...block.matchAll(/'--([a-z][a-z-]*)'/g)].map((m) => m[1] as string);
    expect(passed).toContain('resume');
    const known = new Set(TRAIN_FLAGS.map((f) => f.name));
    expect(passed.filter((name) => !known.has(name))).toEqual([]);
  });

  it('parses --resume, and --noise-tau, alone', () => {
    expect(problems(['--resume'])).toEqual(clean);
    expect(problems(['--noise-tau', '0.5'])).toEqual(clean);
    expect(parse(['--noise-tau', '0.5'], TRAIN_FLAGS).values['noise-tau']).toBe(0.5);
  });

  it('refuses a value that is not what the flag wants, saying what it wanted', () => {
    expect(problems(['--generations', 'abc']).errors).toEqual([
      "--generations wants a positive whole number, not 'abc'",
    ]);
    expect(problems(['--generations', '0']).errors).toHaveLength(1);
    expect(problems(['--population', '33']).errors).toHaveLength(1);
    expect(problems(['--hidden', '32,x']).errors).toHaveLength(1);
    expect(problems(['--seconds', '-1']).errors).toHaveLength(1);
    expect(problems(['--memory', '1.5']).errors).toHaveLength(1);
  });

  it('refuses a value flag followed by another flag instead of a value', () => {
    expect(problems(['--generations', '--resume']).errors).toContain('--generations wants a value');
    expect(problems(['--generations']).errors).toContain('--generations wants a value');
  });

  it('reads negative numbers, lists, and the cord by name', () => {
    const { values, errors } = parse(
      ['--reflex-setpoint', '-0.1', '--hidden', '16,8', '--reflex', 'none', '--memory', '0'],
      TRAIN_FLAGS,
    );
    expect(errors).toEqual([]);
    expect(values).toMatchObject({ 'reflex-setpoint': -0.1, hidden: [16, 8], reflex: 'none' });
    expect(parse(['--reflex', '2'], TRAIN_FLAGS).values.reflex).toBe(2);
    expect(problems(['--reflex', 'strong']).errors).toHaveLength(1);
  });

  it('calls a flag it does not have unknown, and takes its value with it', () => {
    expect(problems(['--name', 'foo'])).toEqual({ errors: [], unknown: ['name'] });
    expect(problems(['--out', 'x.json']).unknown).toEqual(['out']);
  });

  it('knows --help, --force and --print-recipe, and the help names every flag', () => {
    expect(problems(['--help', '--force', '--print-recipe'])).toEqual(clean);
    const help = formatHelp(TRAIN_FLAGS, 'usage');
    for (const flag of TRAIN_FLAGS) expect(help).toContain(`--${flag.name}`);
    expect(help).toContain('(default 300)');
  });

  it('fills in the defaults of flags not given, and says which were given', () => {
    const { values, given } = parse(['--generations', '5'], TRAIN_FLAGS);
    expect(values).toMatchObject({ generations: 5, population: 32, hidden: [32, 32] });
    expect([...given]).toEqual(['generations']);
  });
});
