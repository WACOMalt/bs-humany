#!/usr/bin/env node
/**
 * The section 14.5 audit -- milestone M5.10.
 *
 *   pnpm audit:obligations          # write docs/validation/obligations.md
 *   pnpm audit:obligations --check  # and fail if an obligation has lost its evidence
 *
 * Section 14.5 lists ten things Phase 1 must do that exist only to keep Phase 2 open. Every one
 * of them is the kind of thing that is easy to satisfy once and lose quietly afterwards: a
 * channel field nobody reads yet, a phase nobody runs in, a primitive nobody calls. A checklist
 * in a document would go stale the week after it was written.
 *
 * So each obligation is checked here against the repository as it stands. Where the obligation is
 * structural -- a field on a channel, a member of an interface, a phase in the list -- the check
 * looks at the real thing, by importing the package rather than grepping for a word. Where it is
 * behavioural, the evidence is a named test, and the check confirms that test still exists by
 * that name; whether it passes is the test suite's business, and CI runs both.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { cliFlags } from '../lib/args.mjs';
import { reportIsCurrent } from '../lib/report.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const { check } = cliFlags('audit-obligations');
const jiti = createJiti(import.meta.url);

const kernel = await jiti.import(join(ROOT, 'packages/kernel/src/index.ts'));
const hsdl = await jiti.import(join(ROOT, 'packages/hsdl/src/index.ts'));
const mechanics = await jiti.import(join(ROOT, 'packages/modules-mechanics/src/index.ts'));
const skeleton = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
const compiler = await jiti.import(join(ROOT, 'packages/compiler/src/index.ts'));
const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));

const document = skeleton.buildDocument();
const morphology = resolveMorphology(skeleton.REFERENCE_MORPHOLOGY);
const { articulation } = compiler.compileArticulation(
  document,
  skeleton.REFERENCE_PROFILE,
  morphology,
);

// --- Helpers ------------------------------------------------------------------------------------

const read = (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : '');

/** Every TypeScript source file in the repository, excluding build output. */
function sources(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|mjs)$/.test(entry)) out.push(relative(ROOT, full));
  }
  return out;
}
const ALL_SOURCES = sources();

/**
 * A test that exists by name in a file: the evidence for a behavioural obligation.
 *
 * The name is looked for as a quoted string anywhere in the test file, rather than immediately
 * after an `it(`, because a table-driven test puts its name after the table. Renaming the test
 * breaks this and that is the intent: the name is the evidence, so changing it should be a
 * deliberate act that updates the audit too.
 */
function namedTest(file, pattern) {
  const text = read(file);
  const match = new RegExp(`['"\`]([^'"\`\\n]*${pattern}[^'"\`\\n]*)['"\`]`).exec(text);
  return match
    ? { ok: true, detail: `\`${file}\`: "${match[1]}"` }
    : { ok: false, detail: `no test named /${pattern}/ in \`${file}\`` };
}

/** A field on a channel spec, checked against the spec the code actually builds. */
function channelField(spec, field) {
  const found = spec.fields.find((f) => f.name === field);
  return found
    ? { ok: true, detail: `\`${spec.id}\` has \`${field}\` (${found.dtype}, ${found.components})` }
    : { ok: false, detail: `\`${spec.id}\` has no \`${field}\` field` };
}

/**
 * What Phase 2 has since put into the places obligations 1 and 7 held open.
 *
 * Two of the obligations were written as absences -- a primitive nobody calls, a phase nobody
 * runs in -- because in Phase 1 the only way to tell a slot was being kept for later was that
 * nothing was in it. Phase 2 has begun, and the nerves are exactly what those slots were kept for.
 * Read literally the obligations now fail on the work they existed to make room for, and a check
 * that fails on the right answer teaches everyone to ignore it.
 *
 * So each consumer is named here with the decision that put it there. What the obligation guards
 * against is unchanged: something drifting into the slot by accident, before anyone decided it
 * should. A file that is not on this list still fails, by name, and adding one is meant to be the
 * same deliberate act as the ADR that justifies it.
 */
const PHASE2_CONSUMERS = Object.freeze({
  delayLine: Object.freeze([
    Object.freeze({
      file: 'packages/modules-nerves/src/spinalModule.ts',
      decision: 'ADR-014',
      reason: 'the spinal cord reads its afferents back from a conduction delay ago, per spec 10.5',
    }),
  ]),
  control: Object.freeze([
    Object.freeze({
      file: 'packages/modules-nerves/src/nervesModule.ts',
      decision: 'ADR-013',
      reason: 'the trained policy, between the senses and the muscles',
    }),
    Object.freeze({
      file: 'packages/modules-nerves/src/spinalModule.ts',
      decision: 'ADR-014',
      reason: 'the reflex arcs add onto the same drive as the policy, beneath it',
    }),
    Object.freeze({
      // No ADR covers the noise; the commit that added it is where the decision is written down.
      file: 'packages/modules-nerves/src/noise.ts',
      decision: 'commit bc8fcfc',
      reason: 'a slow tremor added onto the muscles alongside every other driver',
    }),
  ]),
});

/**
 * The evidence for a slot that Phase 1 held open: either still empty, or filled only by the
 * consumers `allowed` names. A consumer found that is not on the list is a gap, by file.
 */
function heldOpen(found, allowed, emptyDetail) {
  if (found.length === 0) {
    return [{ ok: true, detail: `${emptyDetail}: it is held open, as Phase 1 intended` }];
  }
  const expected = found.map((f) => allowed.find((a) => a.file === f)).filter(Boolean);
  const unexpected = found.filter((f) => !allowed.some((a) => a.file === f));
  const out = [];
  if (expected.length > 0) {
    const named = expected.map((a) => `\`${a.file}\` (${a.decision}: ${a.reason})`).join(', ');
    out.push({ ok: true, detail: `held open in Phase 1; now used by ${named}` });
  }
  if (unexpected.length > 0) {
    out.push({
      ok: false,
      detail:
        `used by ${unexpected.map((f) => `\`${f}\``).join(', ')}, which no decision put there: ` +
        'if it belongs, name its ADR in PHASE2_CONSUMERS in this tool',
    });
  }
  return out;
}

const OBLIGATIONS = [
  {
    n: 1,
    text: 'DelayLine primitive built and tested, unused.',
    evidence: () => {
      const out = [];
      out.push(
        typeof kernel.DelayLine === 'function'
          ? { ok: true, detail: '`DelayLine` is exported from `@bs-humany/kernel`' }
          : { ok: false, detail: '`DelayLine` is not exported from the kernel' },
      );
      out.push(namedTest('packages/kernel/src/delayLine.test.ts', 'ticks ago'));
      out.push(namedTest('packages/kernel/src/delayLine.test.ts', 'does not allocate'));
      // "Unused" was the Phase 1 half of this: the primitive existed so that a reflex arc would
      // have somewhere to put its latency, and nothing was to lean on it until one did. One does
      // now. So the check is no longer that nothing uses it but that everything which does was
      // put there on purpose, by a decision that says so.
      // This file names the symbol in order to look for it, and module-lint names `DelayLine.read`
      // as one of the helpers a module's step may call; neither counts as using it.
      const users = ALL_SOURCES.filter(
        (f) =>
          !f.startsWith('packages/kernel/') &&
          f !== 'tools/cli/bin/audit-obligations.mjs' &&
          f !== 'tools/cli/bin/module-lint.mjs' &&
          /\bDelayLine\b/.test(read(f)),
      );
      out.push(
        ...heldOpen(users, PHASE2_CONSUMERS.delayLine, 'nothing outside the kernel uses it'),
      );
      return out;
    },
  },
  {
    n: 2,
    text: 'attachmentSites in HSDL, populated for major landmarks.',
    evidence: () => {
      const sites = document.attachmentSites ?? [];
      // A site's id is `<structure>_<origin|insertion>_<side>_<feature>`, so the structure is
      // what comes before the first of those two words.
      const structures = new Set(sites.map((s) => s.id.split(/_(?:origin|insertion)_/)[0]));
      const kinds = new Set(sites.map((s) => s.kind));
      const bones = new Set(document.bones.map((b) => b.id));
      const orphans = sites.filter((s) => !bones.has(s.bone));
      return [
        sites.length >= 100
          ? {
              ok: true,
              detail: `${sites.length} sites across ${structures.size} structures, as ${[...kinds].join(' and ')}`,
            }
          : { ok: false, detail: `only ${sites.length} sites` },
        orphans.length === 0
          ? { ok: true, detail: 'every site names a bone the document carries' }
          : { ok: false, detail: `${orphans.length} sites name no bone` },
        sites.every((s) => s.source)
          ? { ok: true, detail: 'every site carries a citation' }
          : { ok: false, detail: 'a site is missing its citation' },
      ];
    },
  },
  {
    n: 3,
    text: 'HSDL extension namespaces supported, so modules can annotate without forking.',
    evidence: () => {
      const namespace = hsdl.moduleNamespace('audit');
      const written = hsdl.writeExtension(undefined, namespace, { hello: 'world' });
      const roundTrip = written?.[namespace]?.hello === 'world';
      const used = document.collisionProxies.filter((p) => p.ext && Object.keys(p.ext).length > 0);
      return [
        typeof hsdl.moduleNamespace === 'function' && typeof hsdl.writeExtension === 'function'
          ? { ok: true, detail: '`moduleNamespace` and `writeExtension` are exported' }
          : { ok: false, detail: 'the extension helpers are not exported' },
        roundTrip
          ? { ok: true, detail: `a value written under \`${namespace}\` reads back` }
          : { ok: false, detail: 'an extension did not survive a round trip' },
        used.length > 0
          ? { ok: true, detail: `${used.length} collision proxies carry their provenance this way` }
          : { ok: false, detail: 'nothing in the document uses an extension' },
        existsSync(join(ROOT, 'docs/guides/hsdl-extensions.md'))
          ? { ok: true, detail: '`docs/guides/hsdl-extensions.md` documents the convention' }
          : { ok: false, detail: 'the extension guide is missing' },
      ];
    },
  },
  {
    n: 4,
    text: 'Realized (not just commanded) per-DoF force readable from both backends.',
    evidence: () => {
      const text = read('packages/compiler/src/backend.ts');
      return [
        /realizedDofForce/.test(text)
          ? { ok: true, detail: '`BackendCapabilities.realizedDofForce` declares what each can do' }
          : { ok: false, detail: 'no capability declares realized force support' },
        /realized generalized force per DoF/.test(text) && /readonly force: Float64Array/.test(text)
          ? {
              ok: true,
              detail: '`JointStateBuffer.force` carries it, filled by `readJointState`',
            }
          : { ok: false, detail: 'the joint state buffer has no realized force field' },
        namedTest('packages/testkit/src/realizedForce.test.ts', 'motor torque that holds'),
        namedTest('packages/testkit/src/realizedForce.test.ts', 'constraint torque natively'),
      ];
    },
  },
  {
    n: 5,
    text: 'contact.manifolds published with per-contact impulse from Phase 1.',
    evidence: () => {
      const spec = mechanics.contactManifoldsSpec(16);
      return [
        channelField(spec, 'impulse'),
        channelField(spec, 'point'),
        channelField(spec, 'normal'),
        channelField(spec, 'depth'),
      ];
    },
  },
  {
    n: 6,
    text: 'diagnostics.limits publishes end-range proximity and violation flags.',
    evidence: () => {
      const spec = mechanics.diagnosticsLimitsSpec(articulation);
      return [
        channelField(spec, 'proximity'),
        channelField(spec, 'margin'),
        channelField(spec, 'violation'),
      ];
    },
  },
  {
    n: 7,
    text: 'control phase exists and is empty. rateDivisor works and is tested.',
    evidence: () => {
      const phases = kernel.PHASES ?? [];
      // Every module the repository ships, by the phase its manifest declares.
      const inControl = ALL_SOURCES.filter(
        (f) => f.startsWith('packages/modules-') && /phase:\s*'control'/.test(read(f)),
      );
      return [
        phases.includes('control')
          ? { ok: true, detail: `the phase list is ${phases.join(', ')}` }
          : { ok: false, detail: 'no `control` phase in the list' },
        ...heldOpen(inControl, PHASE2_CONSUMERS.control, 'no module runs in it'),
        namedTest('packages/kernel/src/kernel.test.ts', 'rateDivisor'),
      ];
    },
  },
  {
    n: 8,
    text: 'actuation.* accumulator semantics work with 2+ simultaneous writers, tested.',
    evidence: () => {
      const torque = mechanics.actuationJointTorqueSpec(articulation);
      const wrench = mechanics.actuationBodyWrenchSpec(articulation);
      return [
        torque.mode === 'accumulator'
          ? { ok: true, detail: '`actuation.jointTorque` is an accumulator' }
          : { ok: false, detail: '`actuation.jointTorque` is not an accumulator' },
        wrench.mode === 'accumulator'
          ? { ok: true, detail: '`actuation.bodyWrench` is an accumulator' }
          : { ok: false, detail: '`actuation.bodyWrench` is not an accumulator' },
        namedTest('packages/kernel/src/kernel.test.ts', 'two writers'),
      ];
    },
  },
  {
    n: 9,
    text: 'Articulation recompile-and-restore is lossless and benchmarked.',
    evidence: () => {
      const bench = read('docs/validation/benchmarks.md');
      return [
        typeof compiler.transferJointState === 'function' &&
        typeof compiler.forwardKinematics === 'function'
          ? { ok: true, detail: '`transferJointState` and `forwardKinematics` are exported' }
          : { ok: false, detail: 'the recompile helpers are not exported' },
        namedTest('packages/testkit/src/recompile.test.ts', 'losslessly in joint space'),
        namedTest('packages/testkit/src/recompile.test.ts', 'new stature'),
        /[Rr]ecompile/.test(bench)
          ? { ok: true, detail: '`docs/validation/benchmarks.md` carries the restore timings' }
          : { ok: false, detail: 'no recompile timing in the benchmark report' },
      ];
    },
  },
  {
    n: 10,
    text: 'Bone IDs treated as a stable public ABI, with a documented change policy.',
    evidence: () => {
      const contributing = read('CONTRIBUTING.md');
      const ids = document.bones.map((b) => b.id);
      const unique = new Set(ids);
      const shape = /^[a-z][a-z0-9_]*$/;
      const malformed = ids.filter((id) => !shape.test(id));
      const sided = ids.filter((id) => /_(r|l)$/.test(id));
      return [
        /## Bone ids are a public ABI/.test(contributing)
          ? { ok: true, detail: 'the change policy is in `CONTRIBUTING.md`' }
          : { ok: false, detail: 'no documented change policy for bone ids' },
        unique.size === ids.length
          ? { ok: true, detail: `${ids.length} ids, all distinct` }
          : { ok: false, detail: `${ids.length - unique.size} duplicate ids` },
        malformed.length === 0
          ? { ok: true, detail: `all lower snake case; ${sided.length} carry a side suffix` }
          : { ok: false, detail: `malformed ids: ${malformed.join(', ')}` },
      ];
    },
  },
];

// --- Report ---------------------------------------------------------------------------------------

const results = OBLIGATIONS.map((o) => {
  const evidence = o.evidence();
  return { ...o, evidence, met: evidence.every((e) => e.ok) };
});
const unmet = results.filter((r) => !r.met);

const lines = [
  '# The section 14.5 audit',
  '',
  'Spec section 14.5 lists ten things Phase 1 must do that exist only to keep Phase 2 open.',
  'Each is the kind of thing that is easy to satisfy once and lose quietly afterwards: a channel',
  'field nobody reads yet, a phase nobody runs in, a primitive nobody calls. So rather than a',
  'checklist, each is checked against the repository as it stands.',
  '',
  'Generated by `pnpm audit:obligations`; CI runs it with `--check`, so an obligation that loses',
  'its evidence fails the build. Where an obligation is structural the check looks at the real',
  'thing, by importing the package rather than grepping for a word. Where it is behavioural the',
  'evidence is a named test, and the check confirms that test still exists by that name; whether',
  "it passes is the test suite's business, and CI runs both.",
  '',
  `Generated ${new Date().toISOString().slice(0, 10)}. ${results.length - unmet.length} of ` +
    `${results.length} obligations met.`,
  '',
];
for (const r of results) {
  lines.push(`## ${r.n}. ${r.text}`);
  lines.push('');
  lines.push(r.met ? '**Met.**' : '**Not met.**');
  lines.push('');
  for (const e of r.evidence) lines.push(`- ${e.ok ? '' : '**gap:** '}${e.detail}`);
  lines.push('');
}

const path = join(ROOT, 'docs/validation/obligations.md');
const report = lines.join('\n');
if (check) {
  if (unmet.length > 0) {
    console.error(`Section 14.5 audit: ${unmet.length} obligation(s) not met.`);
    for (const r of unmet) {
      for (const e of r.evidence.filter((x) => !x.ok)) console.error(`  ${r.n}. ${e.detail}`);
    }
    process.exit(1);
  }
  const existing = read('docs/validation/obligations.md');
  if (!reportIsCurrent(existing, report)) {
    console.error(
      'docs/validation/obligations.md is stale. Run `pnpm audit:obligations` and commit it.',
    );
    process.exit(1);
  }
  console.error(`section 14.5 audit: all ${results.length} obligations met, report current.`);
} else if (reportIsCurrent(read('docs/validation/obligations.md'), report)) {
  // Nothing but the date would change, and a date that moves on every run is churn in a commit.
  console.error(`${path} is current: ${results.length - unmet.length} of ${results.length} met.`);
} else {
  writeFileSync(path, `${report}\n`);
  console.error(`wrote ${path}: ${results.length - unmet.length} of ${results.length} met.`);
}
