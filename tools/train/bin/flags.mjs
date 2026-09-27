/**
 * Command-line flags from one table: what each is, what it must look like, and what it is for.
 *
 * The trainer used to read its flags one at a time with a helper that registered a name as
 * "known" only when the line reading it ran. Which flags were known therefore depended on which
 * lines ran: `--resume` was read by another route and was refused as unknown, so resuming from
 * the command line and from the studio both stopped working the day unknown flags began to be
 * refused. A flag that took a value accepted whatever followed it, so `--generations --resume`
 * trained for NaN generations. A table read once, before anything else happens, cannot drift from
 * the code that uses it, and can say what is wrong with every value before a worker is started.
 *
 * Plain JavaScript, because the Node entry points import it directly and so do the tests.
 */

/**
 * What a value must look like, by kind, as the words an error uses, and how to read it.
 * `choices` on an entry are words accepted as they are in place of a number, and `min` and `max`
 * the range, inclusive, that a number must be in.
 */
const KINDS = {
  string: { wants: 'a value', read: (v) => v },
  number: { wants: 'a number', read: (v) => finite(v) },
  positive: { wants: 'a number above zero', read: (v) => above(finite(v), 0) },
  posint: { wants: 'a positive whole number', read: (v) => above(whole(v), 0) },
  int0: { wants: 'a whole number, zero or more', read: (v) => above(whole(v), -1) },
  evenint: {
    wants: 'an even whole number, at least 2',
    read: (v) => {
      const n = whole(v);
      return n !== undefined && n >= 2 && n % 2 === 0 ? n : undefined;
    },
  },
  intlist: {
    wants: 'positive whole numbers separated by commas',
    read: (v) => {
      const list = v.split(',').map((part) => above(whole(part), 0));
      return list.every((n) => n !== undefined) ? list : undefined;
    },
  },
  bool: { wants: 'nothing', read: () => true },
  // Only the entry's `choices`, which are accepted before a kind is consulted; anything else is
  // refused here, and the error lists them.
  choice: { wants: 'one of', read: () => undefined },
};

function finite(v) {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function whole(v) {
  return /^\s*\d+\s*$/.test(v) ? Number(v) : undefined;
}

function above(n, floor) {
  return n !== undefined && n > floor ? n : undefined;
}

/**
 * Read `argv` against `table`. Every entry of the table is known whatever else is given; a value
 * flag must be followed by a value, not by the next flag; every value is checked against its
 * kind. Nothing is thrown and nothing is printed: the caller says what it likes about what comes
 * back, and decides whether to go on.
 */
export function parse(argv, table) {
  const byName = new Map(table.map((entry) => [entry.name, entry]));
  const values = {};
  for (const entry of table) {
    // A copy of a list, so a caller that changes its values cannot change the table's default.
    const fallback = Array.isArray(entry.default) ? [...entry.default] : entry.default;
    if (fallback !== undefined) values[entry.name] = fallback;
  }
  const given = new Set();
  const errors = [];
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      errors.push(`unexpected '${arg}'; every value follows the flag it belongs to`);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const entry = byName.get(name);
    if (!entry) {
      unknown.push(name);
      // Its value, if it has one, goes with it rather than being reported a second time as a
      // stray argument.
      if (eq < 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1;
      continue;
    }
    given.add(name);
    if (entry.kind === 'bool') {
      if (eq >= 0) errors.push(`--${name} takes no value`);
      values[name] = true;
      continue;
    }
    let raw;
    if (eq >= 0) {
      raw = arg.slice(eq + 1);
    } else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      errors.push(`--${name} wants a value`);
      continue;
    } else {
      raw = argv[++i];
    }
    if (entry.choices?.includes(raw)) {
      values[name] = raw;
      continue;
    }
    const kind = KINDS[entry.kind];
    const value = kind.read(raw);
    if (value === undefined) {
      const wants =
        entry.kind === 'choice'
          ? `one of ${entry.choices.join(', ')}`
          : `${kind.wants}${entry.choices ? `, or ${entry.choices.join(' or ')}` : ''}`;
      errors.push(`--${name} wants ${wants}, not '${raw}'`);
      continue;
    }
    if (
      typeof value === 'number' &&
      ((entry.min !== undefined && value < entry.min) ||
        (entry.max !== undefined && value > entry.max))
    ) {
      const what = entry.kind === 'int0' ? 'a whole number' : kind.wants;
      errors.push(`--${name} wants ${what} from ${entry.min} to ${entry.max}, not '${raw}'`);
      continue;
    }
    values[name] = value;
  }
  return { values, given, errors, unknown };
}

/** What a flag wants after it, for the help. */
function placeholder(entry) {
  if (entry.kind === 'bool') return '';
  // A choice's words are listed after its help rather than here: a list of four bodies would push
  // every other line of the help off the side of the terminal.
  if (entry.kind === 'choice') return ' <name>';
  if (entry.choices) return ` <${['n', ...entry.choices].join('|')}>`;
  return entry.kind === 'string' ? ' <text>' : entry.kind === 'intlist' ? ' <n,n>' : ' <n>';
}

/**
 * The help: the header, then a line a flag, with what it accepts -- its words, or its range --
 * and its default where it has one.
 */
export function formatHelp(table, header) {
  const heads = table.map((entry) => `  --${entry.name}${placeholder(entry)}`);
  const width = Math.max(...heads.map((h) => h.length)) + 2;
  const lines = table.map((entry, i) => {
    const fallback =
      entry.default === undefined || entry.kind === 'bool'
        ? ''
        : ` (default ${Array.isArray(entry.default) ? entry.default.join(',') : entry.default})`;
    const accepts =
      entry.kind === 'choice'
        ? ` [${entry.choices.join(', ')}]`
        : entry.min !== undefined && entry.max !== undefined
          ? ` [${entry.min} to ${entry.max}]`
          : '';
    return `${heads[i].padEnd(width)}${entry.help}${accepts}${fallback}`;
  });
  return `${header}\n\n${lines.join('\n')}\n`;
}

/**
 * Every flag `train-nerves.mjs` takes, from the recipe module `tools/train/src/recipe.ts`.
 *
 * A function of that module rather than a table of literals, because the literals were a copy: the
 * command line kept its own defaults, the dashboard its own and the studio its own, and a default
 * changed in one of them stayed the same in the other three. The module is TypeScript and this
 * file is not, so the caller loads it -- the trainer through jiti, a test directly -- and hands it
 * here. What comes from it: the run's length and width, the search's settings, the tasks and
 * bodies there are, and the range every number of the loop is held to. A value outside its range
 * is refused, where the dashboard moves it into range and says so: the dashboard answers a slider
 * that may have been sent anything, and the person who typed a flag is here to be told.
 *
 * The noise and the cord have no defaults, because without a flag they are the recipe's own.
 */
export function trainFlags(recipe) {
  const range = (limit) => ({ min: limit.min, max: limit.max });
  return [
    { name: 'recipe', kind: 'string', help: 'a recipe file: names the run and says what it is in' },
    {
      name: 'task',
      kind: 'choice',
      choices: [...recipe.TASKS],
      default: recipe.TASKS[0],
      help: 'without a recipe: what is scored; also the run name',
    },
    {
      name: 'profile',
      kind: 'choice',
      choices: [...recipe.PROFILES],
      default: recipe.DEFAULT_PROFILE,
      help: 'without a recipe: the body; with --resume, the body to carry the checkpoint onto',
    },
    {
      name: 'authority',
      kind: 'number',
      ...range(recipe.AUTHORITY_LIMIT),
      default: recipe.DEFAULT_AUTHORITY,
      help: 'how much of the drive is the brain',
    },
    {
      name: 'noise',
      kind: 'number',
      ...range(recipe.NOISE_LIMITS.motor),
      help: "the tremor on the muscles; the recipe's when not given",
    },
    {
      name: 'sense-noise',
      kind: 'number',
      ...range(recipe.NOISE_LIMITS.sense),
      help: "the grain on the senses; the recipe's when not given",
    },
    {
      name: 'noise-tau',
      kind: 'number',
      ...range(recipe.NOISE_LIMITS.tau),
      help: "how long one push of the tremor lasts, s; the recipe's when not given",
    },
    {
      name: 'reflex',
      kind: 'number',
      ...range(recipe.REFLEX_LIMITS.stretch),
      choices: ['default', 'none'],
      help: 'the stretch gain; `default` is the measured cord, `none` no cord at all',
    },
    ...Object.entries(REFLEX_FLAGS).map(([name, field]) => ({
      name,
      kind: 'number',
      ...range(recipe.REFLEX_LIMITS[field]),
      help: `the cord: ${REFLEX_HELP[field]}`,
    })),
    {
      name: 'memory',
      kind: 'int0',
      ...range(recipe.MEMORY_LIMIT),
      help: 'context units carried between control steps',
    },
    {
      name: 'generations',
      kind: 'posint',
      default: recipe.CLI_RUN_DEFAULTS.generations,
      help: 'generations to run this time',
    },
    {
      name: 'population',
      kind: 'evenint',
      default: recipe.CLI_RUN_DEFAULTS.population,
      help: 'candidates a generation, in pairs',
    },
    { name: 'workers', kind: 'posint', help: 'worker threads (default one a core, up to 16)' },
    {
      name: 'seconds',
      kind: 'positive',
      default: recipe.SEARCH_DEFAULTS.seconds,
      help: 'the length of an episode, s',
    },
    {
      name: 'seeds',
      kind: 'posint',
      default: recipe.SEARCH_DEFAULTS.seeds,
      help: 'episodes a candidate is scored over',
    },
    {
      name: 'sigma',
      kind: 'positive',
      default: recipe.SEARCH_DEFAULTS.sigma,
      help: 'the size of a perturbation',
    },
    {
      name: 'lr',
      kind: 'positive',
      default: recipe.SEARCH_DEFAULTS.learningRate,
      help: 'the learning rate',
    },
    {
      name: 'hidden',
      kind: 'intlist',
      default: [...recipe.SEARCH_DEFAULTS.hidden],
      help: 'hidden layer widths',
    },
    { name: 'resume', kind: 'bool', help: 'continue the saved checkpoint of this name' },
    { name: 'force', kind: 'bool', help: 'start a checkpoint that exists afresh, replacing it' },
    {
      name: 'print-recipe',
      kind: 'bool',
      help: 'print the recipe this run would train under, and stop',
    },
    { name: 'help', kind: 'bool', help: 'this' },
  ];
}

/**
 * The cord's flags other than `--reflex` itself, each to the one number of the cord it sets, by
 * the name `reflexWithFlags` in the recipe module takes it under.
 */
export const REFLEX_FLAGS = {
  'reflex-velocity': 'velocity',
  'reflex-delay': 'delaySeconds',
  'reflex-inhibition': 'inhibition',
  'reflex-setpoint': 'setPoint',
  'reflex-ceiling': 'forceCeiling',
  'reflex-force-inhibition': 'forceInhibition',
};

/** What each of those numbers is, for the help. */
const REFLEX_HELP = {
  velocity: 'its velocity (damping) gain',
  delaySeconds: 'conduction time down and back, s',
  inhibition: 'reciprocal inhibition',
  setPoint: 'the strain it holds the fibre at',
  forceCeiling: 'the Golgi tendon ceiling',
  forceInhibition: 'how hard the Golgi ceiling inhibits',
};
