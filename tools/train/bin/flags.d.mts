/** Types for `flags.mjs`, which is plain JavaScript because the Node entry points import it directly. */

import type * as Recipe from '../src/recipe.js';

/**
 * What a flag's value must be. `bool` takes none; `positive` is a finite number above zero;
 * `choice` is one of the entry's `choices` and nothing else.
 */
export type FlagKind =
  | 'string'
  | 'number'
  | 'positive'
  | 'posint'
  | 'int0'
  | 'evenint'
  | 'intlist'
  | 'bool'
  | 'choice';

/** One flag: its name without the dashes, its kind, its default, and a line of help. */
export interface FlagEntry {
  readonly name: string;
  readonly kind: FlagKind;
  readonly default?: string | number | boolean | readonly number[];
  /** Words accepted as they are in place of a value of the kind, such as `default` or `none`. */
  readonly choices?: readonly string[];
  /** The range, inclusive, a number must be in. */
  readonly min?: number;
  readonly max?: number;
  readonly help: string;
}

/** What `parse` found: the values (defaults filled in), which were given, and what was wrong. */
export interface Parsed {
  readonly values: Record<string, string | number | boolean | number[] | undefined>;
  readonly given: Set<string>;
  /** One sentence each, such as `--generations wants a positive whole number, not '3OO'`. */
  readonly errors: string[];
  /** Flag names, without the dashes, that the table does not have. */
  readonly unknown: string[];
  /** Numbers moved into their range, with `clamp` set; always empty without it. */
  readonly clamped: Clamped[];
}

/** A number `parse` moved to the nearer end of its entry's range, rather than refusing it. */
export interface Clamped {
  /** The flag, without the dashes. */
  readonly name: string;
  /** What was typed. */
  readonly asked: string;
  /** What the run uses instead: `min` or `max`. */
  readonly used: number;
  readonly min?: number;
  readonly max?: number;
}

/** How `parse` treats a number outside its range. */
export interface ParseOptions {
  /** Move it to the nearer end and list it in `clamped`, rather than report it in `errors`. */
  readonly clamp?: boolean;
}

/** Read an argv against a table; throws nothing and prints nothing. */
export function parse(
  argv: readonly string[],
  table: readonly FlagEntry[],
  options?: ParseOptions,
): Parsed;
/** One clamped value as a sentence: what was typed, what it became, and the range it was held to. */
export function describeClamp(clamped: Clamped): string;
/** The help text: the header, then a line a flag. */
export function formatHelp(table: readonly FlagEntry[], header: string): string;
/** Every flag `train-nerves.mjs` takes, its defaults and ranges from the recipe module. */
export function trainFlags(recipe: typeof Recipe): readonly FlagEntry[];
/** The cord's flags other than `--reflex`, each to the number of the cord it sets. */
export const REFLEX_FLAGS: Readonly<Record<string, (typeof Recipe.REFLEX_FIELDS)[number]>>;
/** The stretch gain's flags one region at a time, each to the region it sets. */
export const REFLEX_REGION_FLAGS: Readonly<Record<string, (typeof Recipe.REFLEX_REGIONS)[number]>>;
