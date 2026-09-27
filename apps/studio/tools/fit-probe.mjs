/**
 * Does the fit actually put their joint centres on ours?
 *
 *   node apps/studio/tools/fit-probe.mjs
 *
 * The whole alignment rests on one claim: that a joint is a place both models agree about, so a
 * transform carrying their joint centres onto ours carries everything else with them. That claim
 * is checkable, and checking it by eye in a viewport has been wrong twice.
 *
 * Every reference model is fitted the way the Align tab fits it after Suggest and Redraw: the
 * pairs suggested by name, from the model's default placement. The paths are found from this
 * file, so it runs from any checkout.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const jiti = createJiti(import.meta.url);
const { Vector3 } = await jiti.import('three');
const { fitBodies, fittedFromPlacement, suggestBodyPairs } = await jiti.import(
  `${ROOT}apps/studio/src/align/retarget.ts`,
);
const { describeFits } = await jiti.import(`${ROOT}apps/studio/src/align/fit.ts`);
const { jointsOnSegment } = await jiti.import(`${ROOT}apps/studio/src/align/ourBody.ts`);
const { defaultPlacement } = await jiti.import(`${ROOT}apps/studio/src/align/sourceOverlay.ts`);
const { buildDocument } = await jiti.import(`${ROOT}packages/skeleton/src/index.ts`);
const { compileArticulation } = await jiti.import(`${ROOT}packages/compiler/src/index.ts`);
const { resolveMorphology } = await jiti.import(`${ROOT}packages/anthropometry/src/index.ts`);

const data = JSON.parse(readFileSync(`${ROOT}apps/studio/public/sourceSites.json`, 'utf8'));
const doc = buildDocument();
const mo = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(doc, 'l3_anatomical', mo);
const jointsOn = (segment) => jointsOnSegment(articulation, segment);

for (const [name, model] of Object.entries(data.models)) {
  const pairs = suggestBodyPairs(
    model,
    articulation.segments.map((s) => s.id),
  );
  const result = fitBodies(
    model,
    pairs,
    articulation,
    jointsOn,
    fittedFromPlacement(defaultPlacement(name)),
  );
  const { fits } = result;

  // Their joints, by the body pair either side, so each can be checked where it should land. Only
  // joints between two directly paired bodies are checked; one through a phantom has no single
  // joint of ours to land on.
  const parentOf = new Map(model.bodies.map((b) => [b.name, b.parent]));
  const ourFor = new Map(pairs.map((p) => [p.theirs, p.ours]));
  console.log(`\n== ${name}: ${pairs.length} pairs suggested`);
  console.log('after the fit, how far their joint centres land from ours:\n');
  console.log('  joint                         through      lands    off by');
  const misses = [];
  const checked = new Set();
  for (const joint of model.joints) {
    const body = joint.body;
    const parent = parentOf.get(body);
    if (!body || !parent) continue;
    const ourA = ourFor.get(body);
    const ourB = ourFor.get(parent);
    if (!ourA || !ourB) continue;
    // Several degrees of freedom share one anchor; one line for the place they describe.
    const key = `${body}@${joint.anchor.map((c) => c.toFixed(4)).join(',')}`;
    if (checked.has(key)) continue;
    checked.add(key);
    // The same joint in our body, found as the one between the two paired segments.
    const match = jointsOn(ourA).find((p) => p.other === ourB);
    const fit = fits.get(body);
    if (!match || !fit) continue;
    const moved = new Vector3(joint.anchor[0], joint.anchor[1], joint.anchor[2])
      .multiplyScalar(fit.scale)
      .applyQuaternion(fit.rotation)
      .add(fit.position);
    const off = 1000 * moved.distanceTo(match.at);
    misses.push(off);
    console.log(`  ${joint.name.padEnd(28)} ${body.padEnd(11)} ${off.toFixed(1).padStart(7)} mm`);
  }
  misses.sort((a, b) => a - b);
  if (misses.length > 0) {
    console.log(
      `\n  ${misses.length} joints: median ${misses[Math.floor(misses.length / 2)].toFixed(1)} mm, ` +
        `worst ${misses[misses.length - 1].toFixed(1)} mm`,
    );
  }
  console.log('\n  per bone, what the fit rested on:');
  for (const [body, fit] of fits) {
    console.log(
      `    ${body.padEnd(11)} -> ${fit.ours.padEnd(12)} ${fit.kind.padEnd(24)} ` +
        `matched ${fit.matched}  scale ${fit.scale.toFixed(3)}`,
    );
  }
  console.log(`\n  ${describeFits(result, model.bodies)}`);
}
