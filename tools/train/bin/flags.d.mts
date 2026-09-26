/** Types for `flags.mjs`, which is plain JavaScript because the Node entry points import it directly. */

/** What a flag's value must be. `bool` takes none; `positive` is a finite number above zero. */
export type FlagKind =
  | 'string'
  | 'number'
  | 'positive'
  | 'posint'
  | 'int0'
  | 'evenint'
  | 'intlist'
  | 'bool';

/** One flag: its name without the dashes, its kind, its default, and a line of help. */
export interface FlagEntry {
  readonly name: string;
  readonly kind: FlagKind;
  readonly default?: string | number | boolean | readonly number[];
  /** Words accepted as they are in place of a value of the kind, such as `default` or `none`. */
  readonly choices?: readonly string[];
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
}

/** Read an argv against a table; throws nothing and prints nothing. */
export function parse(argv: readonly string[], table: readonly FlagEntry[]): Parsed;
/** The help text: the header, then a line a flag. */
export function formatHelp(table: readonly FlagEntry[], header: string): string;
/** Every flag `train-nerves.mjs` takes. */
export const TRAIN_FLAGS: readonly FlagEntry[];
