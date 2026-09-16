import { createJiti } from '/home/bsumsxyz/bs-humany-module-muscley/node_modules/jiti/lib/jiti.mjs';
const R = '/home/bsumsxyz/bs-humany-module-muscley/';
const jiti = createJiti(import.meta.url);
const { resolveMorphology } = await jiti.import(R + 'packages/anthropometry/src/index.ts');
const { compileArticulation } = await jiti.import(R + 'packages/compiler/src/index.ts');
const { buildDocument } = await jiti.import(R + 'packages/skeleton/src/index.ts');
const md = await jiti.import(R + 'packages/muscle-data/src/index.ts');
const mm = await jiti.import(R + 'packages/modules-muscle/src/index.ts');
const doc = buildDocument();
const morph = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(doc, 'l3_anatomical', morph);
const set = mm.compileMuscleSet(
  [...md.ELBOW_MUSCLES],
  doc.attachmentSites,
  articulation,
  morph.context,
  doc.wrappingSurfaces ?? [],
);
console.log('unit                        rest     Lts      L0   shortest path   slack at');
for (const u of set.units) {
  const r = md.muscleLengthRange(u.id);
  const shortest = r.shortest * u.restLength;
  const taut = u.parameters.tendonSlackLength;
  console.log(
    u.id.padEnd(26),
    (u.restLength * 1000).toFixed(1).padStart(6),
    (taut * 1000).toFixed(1).padStart(7),
    (u.parameters.optimalFiberLength * 1000).toFixed(0).padStart(6),
    (shortest * 1000).toFixed(1).padStart(12) + 'mm',
    shortest < taut ? ' SLACK past this pose' : '',
  );
}
