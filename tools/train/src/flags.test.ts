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
import { REFLEX_FLAGS, formatHelp, parse, trainFlags } from '../bin/flags.mjs';
import * as recipe from './recipe.js';

const ROOT = join(import.meta.dirname, '../../..');
/** The table the trainer reads, built from the recipe module exactly as the trainer builds it. */
const TRAIN_FLAGS = trainFlags(recipe);

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

  it('takes every default from the recipe module, not from a copy of it', () => {
    const { values } = parse([], TRAIN_FLAGS);
    expect(values).toEqual({
      task: recipe.TASKS[0],
      profile: recipe.DEFAULT_PROFILE,
      authority: recipe.DEFAULT_AUTHORITY,
      generations: recipe.CLI_RUN_DEFAULTS.generations,
      population: recipe.CLI_RUN_DEFAULTS.population,
      seconds: recipe.SEARCH_DEFAULTS.seconds,
      seeds: recipe.SEARCH_DEFAULTS.seeds,
      sigma: recipe.SEARCH_DEFAULTS.sigma,
      lr: recipe.SEARCH_DEFAULTS.learningRate,
      hidden: [...recipe.SEARCH_DEFAULTS.hidden],
    });
  });

  it('refuses a task or a body the recipe module does not have, listing the ones it does', () => {
    expect(problems(['--task', 'blance']).errors).toEqual([
      "--task wants one of stand, balance, not 'blance'",
    ]);
    // `walk` was once accepted, had a clip picked for it, and was trained as a stand.
    expect(problems(['--task', 'walk']).errors).toHaveLength(1);
    expect(problems(['--task', 'balance'])).toEqual(clean);
    expect(problems(['--profile', 'l9_imaginary']).errors[0]).toContain('l3_anatomical');
    expect(problems(['--profile', 'l1_standard'])).toEqual(clean);
  });

  it('holds every number of the loop to the range the recipe module gives it', () => {
    const { max: delayMax } = recipe.REFLEX_LIMITS.delaySeconds;
    expect(problems(['--reflex-delay', String(delayMax * 2)]).errors).toEqual([
      `--reflex-delay wants a number from 0 to ${delayMax}, not '${delayMax * 2}'`,
    ]);
    expect(problems(['--reflex-delay', String(delayMax)])).toEqual(clean);
    expect(
      problems(['--reflex', String(recipe.REFLEX_LIMITS.stretch.max + 1)]).errors,
    ).toHaveLength(1);
    expect(problems(['--reflex-setpoint', '-0.6']).errors).toHaveLength(1);
    expect(problems(['--authority', '1.5']).errors).toHaveLength(1);
    expect(problems(['--noise', '-0.1']).errors).toHaveLength(1);
    expect(problems(['--noise-tau', '0']).errors).toHaveLength(1);
    expect(problems(['--memory', String(recipe.MEMORY_LIMIT.max + 1)]).errors).toEqual([
      `--memory wants a whole number from 0 to ${recipe.MEMORY_LIMIT.max}, not '${recipe.MEMORY_LIMIT.max + 1}'`,
    ]);
  });

  it('gives each number of the cord one flag, and each flag one number', () => {
    // `--reflex` is the stretch; every other number of the cord has a flag of its own.
    const fields = Object.values(REFLEX_FLAGS);
    expect(new Set(fields).size).toBe(fields.length);
    expect(['stretch', ...fields].sort()).toEqual([...recipe.REFLEX_FIELDS].sort());
    for (const flag of Object.keys(REFLEX_FLAGS)) {
      expect(TRAIN_FLAGS.some((f) => f.name === flag)).toBe(true);
    }
  });
});
