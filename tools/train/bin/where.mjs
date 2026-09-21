#!/usr/bin/env node
/** Print where bs-humany keeps things, so a person can go and look. */
import { readdirSync } from 'node:fs';
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
console.log('\nBS_HUMANY_HOME overrides all of it.');
