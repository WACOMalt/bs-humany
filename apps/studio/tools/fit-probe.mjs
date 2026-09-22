/**
 * Does the fit actually put their joint centres on ours?
 *
 *   node apps/studio/tools/fit-probe.mjs
 *
 * The whole alignment rests on one claim: that a joint is a place both models agree about, so a
 * transform carrying their joint centres onto ours carries everything else with them. That claim
 * is checkable, and checking it by eye in a viewport has been wrong twice.
 */
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';

const ROOT = '/home/bsumsxyz/bs-humany-module-muscley/';
const jiti = createJiti(import.meta.url);
const { Vector3 } = await jiti.import('three');
const { fitBodies } = await jiti.import(`${ROOT}apps/studio/src/align/retarget.ts`);
const { buildDocument } = await jiti.import(`${ROOT}packages/skeleton/src/index.ts`);
const { compileArticulation } = await jiti.import(`${ROOT}packages/compiler/src/index.ts`);
const { resolveMorphology } = await jiti.import(`${ROOT}packages/anthropometry/src/index.ts`);
const { transformPoint } = await jiti.import(`${ROOT}packages/frames/src/index.ts`);

const data = JSON.parse(readFileSync(`${ROOT}apps/studio/public/sourceSites.json`, 'utf8'));
const model = data.models.legs;
const doc = buildDocument();
const mo = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(doc, 'l3_anatomical', mo);

const pairs = [
  ['pelvis', 'pelvis'],
  ['femur_r', 'thigh_r'],
  ['tibia_r', 'shank_r'],
  ['talus_r', 'talus_r'],
  ['calcn_r', 'calcaneus_r'],
  ['toes_r', 'toes_r'],
  ['patella_r', 'patella_r'],
  ['femur_l', 'thigh_l'],
  ['tibia_l', 'shank_l'],
  ['talus_l', 'talus_l'],
  ['calcn_l', 'calcaneus_l'],
  ['toes_l', 'toes_l'],
  ['patella_l', 'patella_l'],
].map(([theirs, ours]) => ({ theirs, ours }));

const jointsOn = (segment) => {
  const index = articulation.segments.findIndex((s) => s.id === segment);
  if (index < 0) return [];
  const out = [];
  for (const joint of articulation.joints) {
    const onParent = joint.parentSegment === index;
    const onChild = joint.childSegment === index;
    if (!onParent && !onChild) continue;
    const seg = articulation.segments[onParent ? joint.parentSegment : joint.childSegment];
    const other = articulation.segments[onParent ? joint.childSegment : joint.parentSegment];
    const frame = onParent ? joint.frameInParent : joint.frameInChild;
    if (!seg || !other) continue;
    const p = transformPoint(seg.restWorld, frame.translation);
    out.push({ at: new Vector3(p.x, p.y, p.z), other: other.id, axes: [] });
  }
  return out;
};

const fits = fitBodies(model, pairs, articulation, jointsOn);

// Their joints, by the body pair either side, so each can be checked where it should land.
const parentOf = new Map(model.bodies.map((b) => [b.name, b.parent]));
const ourFor = new Map(pairs.map((p) => [p.theirs, p.ours]));
console.log('after the fit, how far their joint centres land from ours:\n');
console.log('  joint                         through      lands    off by');
const misses = [];
for (const joint of model.joints) {
  const body = joint.body;
  const parent = parentOf.get(body);
  if (!body || !parent) continue;
  const ourA = ourFor.get(body);
  const ourB = ourFor.get(parent);
  if (!ourA || !ourB) continue;
  // The same joint in our body, found as the one between the two paired segments.
  const match = jointsOn(ourA).find((p) => p.other === ourB);
  if (!match) continue;
  for (const [name, through] of [
    [body, 'child'],
    [parent, 'parent'],
  ]) {
    const fit = fits.get(name);
    if (!fit) continue;
    const moved = new Vector3(joint.anchor[0], joint.anchor[1], joint.anchor[2])
      .multiplyScalar(fit.scale)
      .applyQuaternion(fit.rotation)
      .add(fit.position);
    const off = 1000 * moved.distanceTo(match.at);
    if (through === 'child') {
      misses.push(off);
      console.log(`  ${joint.name.padEnd(28)} ${name.padEnd(11)} ${off.toFixed(1).padStart(7)} mm`);
    }
  }
}
misses.sort((a, b) => a - b);
console.log(
  `\n  ${misses.length} joints: median ${misses[Math.floor(misses.length / 2)].toFixed(1)} mm, ` +
    `worst ${misses[misses.length - 1].toFixed(1)} mm`,
);
console.log('\n  per bone, what the fit rested on:');
for (const [name, fit] of fits) {
  console.log(
    `    ${name.padEnd(11)} -> ${fit.ours.padEnd(12)} ${fit.kind.padEnd(24)} ` +
      `scale ${fit.scale.toFixed(3)}`,
  );
}
