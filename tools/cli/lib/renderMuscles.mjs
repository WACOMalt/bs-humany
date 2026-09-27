/**
 * Renders a muscle region file from plain group and unit objects: the one writer behind every
 * generated set in packages/muscle-data/src.
 *
 * The neck, the shoulder girdle and the intercostals call `renderMuscleGroups` directly, because
 * their parameters come from somewhere other than a MyoSuite actuator and each of those sets cites
 * its own way, so they hand it the citation expression per unit as text. The nine sets that read
 * MyoSuite come through `renderGroups` in `myoSuite.mjs`, which builds the same group objects from
 * its units and calls this. There used to be two writers, one per kind, and only one of them knew
 * where the formatter breaks a path: a long site id in a landmark-style set went out on one line,
 * `biome format` broke it, and the generator's `--check` then called the formatted file stale.
 *
 * The output is what Biome would format, to the column, so a generator's `--check` can compare
 * the file byte for byte. A generated file has to be what `biome format` would leave behind or the
 * lint gate and the `--check` gate disagree forever: one rewrites the file and the other then says
 * the data is stale. tools/cli/src/renderMuscles.test.ts holds this to the formatter itself.
 */

/** Biome's configured line width (biome.json), which generated output has to respect. */
export const LINE_WIDTH = 100;

/** Six significant figures: more than the source states, and enough to round-trip it. */
export const num = (v) => Number(v.toPrecision(6)).toString();

/**
 * One `name: 'value',` field at eight spaces, wrapped where the formatter would wrap it.
 *
 * Extensor carpi radialis brevis is the case that needed it: its insertion is on the styloid
 * process of the third metacarpal, and the site id that makes runs past a hundred columns.
 */
export function quoted(name, value) {
  const single = `        ${name}: '${value}',`;
  return single.length <= LINE_WIDTH ? single : `        ${name}:\n          '${value}',`;
}

/**
 * One path element as the lines it becomes, ending in a newline.
 *
 * A site is `{ kind: 'site', id }`. A wrap is `{ kind: 'wrap', surface, preferredSide, source }`,
 * with `source` the citation expression as text.
 */
function renderElement(element) {
  if (element.kind === 'wrap') {
    const { x, y, z } = element.preferredSide;
    return `          {
            kind: 'wrap',
            surface: '${element.surface}',
            preferredSide: { x: ${x}, y: ${y}, z: ${z} },
            source: ${element.source},
          },\n`;
  }
  const single = `          { kind: 'site', site: '${element.id}' },`;
  // The formatter breaks a line past a hundred columns, and a finger tendon's site ids are long
  // enough to reach it. A generator whose output has to be reformatted cannot check its own
  // output, so it writes the broken form itself.
  if (single.length <= LINE_WIDTH) return `${single}\n`;
  return `          {
            kind: 'site',
            site: '${element.id}',
          },\n`;
}

/**
 * A unit's path, as the text that follows `path: `.
 *
 * None at all is an empty pair, which is a straight line from origin to insertion, as several of
 * the knee flexors are. A single element that fits goes on one line, which is how the formatter
 * writes it; one long site id is enough to push that line past the width, and then it breaks like
 * any longer path, one element a line inside the brackets.
 */
export function renderPath(elements) {
  const text = elements.map(renderElement).join('');
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return '[]';
  const oneLine = `[${text.trim().replace(/,$/, '')}]`;
  if (lines.length === 1 && `        path: ${oneLine},`.length <= LINE_WIDTH) return oneLine;
  return `[\n${text}        ]`;
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
 *   origin, insertion, path?: [siteId | element...], parameters: { maxIsometricForce,
 *   optimalFiberLength, tendonSlackLength, pennationAngle?, maxContractionVelocity? }, source }] }`,
 *   where each `source` is the citation expression as it should appear in the file, e.g.
 *   `gray('Splenius')`, and a path entry is a site id or an element as `renderPath` takes it.
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
      const elements = (unit.path ?? []).map((e) =>
        typeof e === 'string' ? { kind: 'site', id: e } : e,
      );
      body.push(`      {
        id: '${unit.id}',
        displayName: '${unit.displayName}',
${quoted('origin', unit.origin)}
${quoted('insertion', unit.insertion)}
        path: ${renderPath(elements)},
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
