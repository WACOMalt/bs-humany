#!/usr/bin/env node
/**
 * Dump the structure of an FBX file: node hierarchy, mesh names, vertex counts, world bounds.
 *
 * Discovery tool for M1.11. Run before writing any mapping, so the mapping is written against what
 * the file actually contains rather than what its name suggests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

globalThis.window ??= { innerWidth: 1, innerHeight: 1 };
globalThis.self ??= globalThis;
const { Box3, Vector3 } = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const [, , input, output] = process.argv;
if (!input) throw new Error('usage: inspect-fbx <file.fbx> [dump.json]');

const buffer = readFileSync(input);
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const root = new FBXLoader().parse(arrayBuffer, '');
root.updateMatrixWorld(true);

const meshes = [];
const nodes = [];
root.traverse((o) => {
  const depth = (() => {
    let d = 0;
    let p = o;
    while (p.parent) {
      d++;
      p = p.parent;
    }
    return d;
  })();
  nodes.push({
    depth,
    type: o.type,
    name: o.name,
    parent: o.parent?.name ?? null,
    children: o.children.length,
  });
  if (o.isMesh) {
    const g = o.geometry;
    const box = new Box3().setFromObject(o);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    meshes.push({
      name: o.name,
      parent: o.parent?.name ?? null,
      vertices: g.attributes.position?.count ?? 0,
      triangles: g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3,
      groups: g.groups?.length ?? 0,
      centre: [centre.x, centre.y, centre.z].map((v) => +v.toFixed(3)),
      size: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
      position: o.position.toArray().map((v) => +v.toFixed(3)),
      scale: o.scale.toArray().map((v) => +v.toFixed(4)),
      materials: Array.isArray(o.material) ? o.material.length : 1,
    });
  }
});

const all = new Box3().setFromObject(root);
const size = all.getSize(new Vector3());
const summary = {
  file: basename(input),
  nodeCount: nodes.length,
  meshCount: meshes.length,
  totalVertices: meshes.reduce((a, m) => a + m.vertices, 0),
  overallMin: all.min.toArray().map((v) => +v.toFixed(3)),
  overallMax: all.max.toArray().map((v) => +v.toFixed(3)),
  overallSize: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
  rootChildren: root.children.map((c) => `${c.type}:${c.name}(${c.children.length})`),
  maxDepth: Math.max(...nodes.map((n) => n.depth)),
};
console.log(JSON.stringify(summary, null, 2));
console.log('\n--- first 40 mesh names ---');
for (const m of meshes.slice(0, 40))
  console.log(`${m.vertices.toString().padStart(7)}v  ${m.name}   <- ${m.parent}`);
console.log('\n--- depth-1/2 node names (up to 60) ---');
for (const n of nodes.filter((n) => n.depth >= 1 && n.depth <= 2).slice(0, 60))
  console.log(`${'  '.repeat(n.depth)}${n.type} ${n.name} [${n.children}]`);
if (output) writeFileSync(output, JSON.stringify({ summary, nodes, meshes }, null, 1));
