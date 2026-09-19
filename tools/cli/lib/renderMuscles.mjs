/**
 * Renders a muscle region file from plain group and unit objects, for the sets whose parameters
 * come from somewhere other than a MyoSuite actuator -- the neck, the shoulder girdle, the
 * intercostals. `renderGroups` in `myoSuite.mjs` does the same for the ones that do; this one
 * takes the citation expression per unit as text, because each of those sets cites its own way.
 *
 * The output is what Biome would format, to the column, so a generator's `--check` can compare
 * the file byte for byte (see `myoSuite.mjs` on why that matters).
 */

import { num } from './myoSuite.mjs';

const LINE_WIDTH = 100;

function quoted(name, value) {
  const single = `        ${name}: '${value}',`;
  return single.length <= LINE_WIDTH ? single : `        ${name}:\n          '${value}',`;
}

/**
 * A unit's citation, on one line when it fits and otherwise as the formatter would break a call:
 * one argument a line, trailing comma. `source` is the expression as text, or `{ call, args }`
 * with each argument already as text.
 */
function sourceLine(source) {
  if (typeof source === 'string') return `          source: ${source},`;
  const single = `          source: ${source.call}(${source.args.join(', ')}),`;
  if (single.length <= LINE_WIDTH) return single;
  return `          source: ${source.call}(\n${source.args.map((a) => `            ${a},`).join('\n')}\n          ),`;
}

/**
 * @param groups `{ id, displayName, taTerm?, innervation?, source, units: [{ id, displayName,
 *   origin, insertion, path?: [siteId...], parameters: { maxIsometricForce, optimalFiberLength,
 *   tendonSlackLength, pennationAngle?, maxContractionVelocity? }, source }] }`, where each
 *   `source` is the citation expression as it should appear in the file, e.g. `gray('Splenius')`.
 */
export function renderMuscleGroups(groups) {
  const body = [];
  for (const group of groups) {
    body.push(`  {
    id: '${group.id}',
    displayName: '${group.displayName}',${group.taTerm ? `\n    taTerm: '${group.taTerm}',` : ''}${
      group.innervation ? `\n    innervation: '${group.innervation}',` : ''
    }
    source: ${group.source},
    units: [`);
    for (const unit of group.units) {
      const p = unit.parameters;
      const elements = (unit.path ?? [])
        .map((id) => `          { kind: 'site', site: '${id}' },\n`)
        .join('');
      const lines = elements.split('\n').filter((line) => line.length > 0);
      const path =
        lines.length === 0
          ? '[]'
          : lines.length === 1
            ? `[${elements.trim().replace(/,$/, '')}]`
            : `[\n${elements}        ]`;
      body.push(`      {
        id: '${unit.id}',
        displayName: '${unit.displayName}',
${quoted('origin', unit.origin)}
${quoted('insertion', unit.insertion)}
        path: ${path},
        parameters: {
          maxIsometricForce: ${num(p.maxIsometricForce)},
          optimalFiberLength: ${num(p.optimalFiberLength)},
          tendonSlackLength: ${num(p.tendonSlackLength)},
          pennationAngle: ${num(p.pennationAngle ?? 0)},${
            p.maxContractionVelocity === undefined
              ? ''
              : `\n          maxContractionVelocity: ${num(p.maxContractionVelocity)},`
          }
${sourceLine(unit.source)}
        },
      },`);
    }
    body.push('    ],\n  },');
  }
  return body.join('\n');
}

/** Both sides of a one-sided table: `$` in any string takes the side, right first then left. */
export function bothSides(groups) {
  const sided = (value, s) => (typeof value === 'string' ? value.replaceAll('$', s) : value);
  const walk = (value, s) =>
    Array.isArray(value)
      ? value.map((v) => walk(v, s))
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, s)]))
        : sided(value, s);
  return ['r', 'l'].flatMap((s) => groups.map((g) => walk(g, s)));
}

/** World distance between two landmark positions, metres. */
export function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
