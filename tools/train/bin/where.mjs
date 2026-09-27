#!/usr/bin/env node
/** Print where bs-humany keeps things, so a person can go and look. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataHome, policiesDir, runsDir } from './home.mjs';

console.log(`data     ${dataHome()}`);
console.log(`policies ${policiesDir()}`);
console.log(`runs     ${runsDir()}`);
const held = readdirSync(policiesDir()).filter((f) => f.endsWith('.json'));
console.log(
  held.length
    ? `\n${held.length} checkpoint${held.length === 1 ? '' : 's'}: ${held.map((f) => f.replace(/\.json$/, '')).join(', ')}`
    : '\nno checkpoints yet',
);
// The recipes the dashboard has written, which are what `--recipe` takes: a run is named by one.
const recipes = readdirSync(runsDir())
  .filter((f) => f.endsWith('-recipe.json'))
  .map((f) => f.slice(0, -'-recipe.json'.length));
console.log(
  recipes.length
    ? `${recipes.length} recipe${recipes.length === 1 ? '' : 's'}: ${recipes.join(', ')} (train one with --recipe ${join(runsDir(), '<name>-recipe.json')})`
    : 'no recipes yet',
);
console.log('\nBS_HUMANY_HOME overrides all of it.');
