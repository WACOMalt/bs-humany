import { resolveMorphology } from '@bs-humany/anthropometry';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { QUALITY_LOW, QUALITY_MEDIUM } from './mesh/types.js';
import { buildSkeletonMesh, computeWorldTransforms, skeletonBounds } from './skeletonMesh.js';

const document = buildDocument();
const context = (stature = 1.7, sex = 0.5) => resolveMorphology({ sex, stature, mass: 70 }).context;

describe('world transforms', () => {
  const world = computeWorldTransforms(document, context());

  it('resolves every bone', () => {
    expect(world.size).toBe(206);
  });

  it('produces finite transforms throughout', () => {
    for (const [id, transform] of world) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(Number.isFinite(transform.translation[axis]), `${id}.${axis}`).toBe(true);
      }
    }
  });

  it('stands the skeleton the right way up, with joint centres at plausible heights', () => {
    // The layout numbers are fractions of stature from Drillis & Contini. This checks the tree
    // composition actually lands them where the table says, which is a real end-to-end assertion
    // over ~25 chained transforms.
    const y = (id: string) => world.get(id)?.translation.y ?? Number.NaN;

    // Femur origin is the knee joint centre; tibia origin is the ankle.
    expect(y('femur_r')).toBeCloseTo(1.7 * 0.285, 2);
    expect(y('tibia_r')).toBeCloseTo(1.7 * 0.039, 2);
    expect(y('hip_r')).toBeCloseTo(1.7 * 0.53, 2);

    // Ordered bottom to top.
    expect(y('tibia_r')).toBeLessThan(y('femur_r'));
    expect(y('femur_r')).toBeLessThan(y('hip_r'));
    expect(y('hip_r')).toBeLessThan(y('sacrum'));
    expect(y('sacrum')).toBeLessThan(y('vertebra_t1'));
    expect(y('vertebra_t1')).toBeLessThan(y('vertebra_c1'));
    expect(y('vertebra_c1')).toBeLessThan(y('frontal'));
  });

  it('puts the right side at positive X and the left at negative', () => {
    // The canonical frame has +X as the subject's right (ADR-010), chosen so femur_r has positive
    // X and 206 bone definitions need no mental negation.
    for (const id of ['femur_r', 'humerus_r', 'hip_r', 'scapula_r']) {
      expect(world.get(id)?.translation.x ?? 0, id).toBeGreaterThan(0);
    }
    for (const id of ['femur_l', 'humerus_l', 'hip_l', 'scapula_l']) {
      expect(world.get(id)?.translation.x ?? 0, id).toBeLessThan(0);
    }
  });

  it('mirrors left and right across the midline', () => {
    for (const base of ['femur', 'tibia', 'humerus', 'ulna', 'hip', 'scapula', 'clavicle']) {
      const right = world.get(`${base}_r`);
      const left = world.get(`${base}_l`);
      expect(right, base).toBeDefined();
      expect(left, base).toBeDefined();
      if (!right || !left) continue;
      expect(right.translation.x + left.translation.x, `${base} X`).toBeCloseTo(0, 6);
      expect(right.translation.y, `${base} Y`).toBeCloseTo(left.translation.y, 6);
      expect(right.translation.z, `${base} Z`).toBeCloseTo(left.translation.z, 6);
    }
  });

  it('places every unpaired bone on the midline', () => {
    // This is a whole class of bug, and it is easy to introduce. The taxonomy has to pick one side
    // as the parent for a bone that articulates bilaterally -- the sternum onto rib_1_l, the
    // mandible onto temporal_l -- so the child's own offset has to cancel the parent's. Getting
    // the sign wrong put the sternum 4 cm off-centre and dragged both clavicles, both scapulae and
    // both arms with it, while every individual bone still looked correct in isolation.
    const unpaired = document.bones.filter((b) => b.side === undefined);
    expect(unpaired.length).toBeGreaterThan(25);
    for (const bone of unpaired) {
      const x = world.get(bone.id)?.translation.x ?? Number.NaN;
      expect(Math.abs(x), `${bone.id} (${bone.displayName}) is off the midline`).toBeLessThan(1e-6);
    }
  });

  it('scales the whole skeleton with stature', () => {
    const short = computeWorldTransforms(document, context(1.5));
    const tall = computeWorldTransforms(document, context(2.0));
    const ratio =
      (tall.get('vertebra_c1')?.translation.y ?? 1) /
      (short.get('vertebra_c1')?.translation.y ?? 1);
    expect(ratio).toBeCloseTo(2.0 / 1.5, 2);
  });
});

describe('skeleton mesh', () => {
  const mesh = buildSkeletonMesh(document, context(), { quality: QUALITY_LOW });

  it('includes every bone', () => {
    expect(mesh.bones.length).toBe(206);
  });

  it('produces a well-formed merged buffer', () => {
    expect(mesh.positions.length % 3).toBe(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.boneIndex.length).toBe(mesh.positions.length / 3);
    expect(mesh.indices.length % 3).toBe(0);

    const vertexCount = mesh.positions.length / 3;
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(vertexCount);
    }
    for (const value of mesh.positions) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('keeps normals unit length after the world transform', () => {
    const count = mesh.positions.length / 3;
    for (let i = 0; i < count; i += 37) {
      const length = Math.hypot(
        mesh.normals[i * 3] ?? 0,
        mesh.normals[i * 3 + 1] ?? 0,
        mesh.normals[i * 3 + 2] ?? 0,
      );
      expect(length).toBeCloseTo(1, 4);
    }
  });

  it('tags every vertex with the bone it belongs to', () => {
    // The attribute is what lets picking resolve to a bone id after the merge into one draw call.
    for (const bone of mesh.bones) {
      for (let i = bone.vertexStart; i < bone.vertexStart + bone.vertexCount; i++) {
        expect(mesh.boneIndex[i], bone.id).toBe(bone.index);
      }
    }
  });

  it('spans from the ground to roughly the stature', () => {
    const { min, max } = skeletonBounds(mesh);
    // The skeleton excludes soft tissue, so the vertex of the skull sits a little below stature.
    expect(max[1]).toBeGreaterThan(1.55);
    expect(max[1]).toBeLessThan(1.75);
    // Feet near the ground.
    expect(min[1]).toBeGreaterThan(-0.05);
    expect(min[1]).toBeLessThan(0.1);
    // Shoulder-width-ish, not sprawling.
    expect(max[0] - min[0]).toBeGreaterThan(0.2);
    expect(max[0] - min[0]).toBeLessThan(0.8);
  });

  it('fits a mobile triangle budget at low quality', () => {
    // ADR-010: L0 must run on mobile. One merged draw call plus a modest triangle count is what
    // makes 206 bones viable on a phone.
    expect(mesh.triangleCount).toBeLessThan(120_000);
  });

  it('gets denser at higher quality', () => {
    const better = buildSkeletonMesh(document, context(), { quality: QUALITY_MEDIUM });
    expect(better.triangleCount).toBeGreaterThan(mesh.triangleCount);
  });

  it('honours an include filter', () => {
    const filtered = buildSkeletonMesh(document, context(), {
      quality: QUALITY_LOW,
      include: new Set(['femur_l', 'femur_r']),
    });
    expect(filtered.bones.map((b) => b.id).sort()).toEqual(['femur_l', 'femur_r']);
  });

  it('reshapes with morphology, which is the whole point of ADR-005', () => {
    const short = skeletonBounds(
      buildSkeletonMesh(document, context(1.5), { quality: QUALITY_LOW }),
    );
    const tall = skeletonBounds(
      buildSkeletonMesh(document, context(2.0), { quality: QUALITY_LOW }),
    );
    expect(tall.max[1] / short.max[1]).toBeCloseTo(2.0 / 1.5, 1);
  });

  it('widens the pelvis at the female-typical endpoint', () => {
    const hipSpan = (sex: number) => {
      const world = computeWorldTransforms(document, context(1.7, sex));
      return (world.get('hip_r')?.translation.x ?? 0) - (world.get('hip_l')?.translation.x ?? 0);
    };
    expect(hipSpan(0)).toBeGreaterThan(hipSpan(1));
  });

  it('names the bone when a recipe fails', () => {
    // A recipe failure in a 206-bone build is otherwise a stack trace with no indication of which
    // entry is wrong.
    // Division by zero throws whatever the context, so this isolates the error-reporting path
    // rather than tripping over an unrelated bone that needs a parameter the context lacks.
    const broken = {
      ...document,
      bones: document.bones.map((b) =>
        b.id === 'femur_r'
          ? { ...b, geometry: { kind: 'sphere' as const, radius: { div: [1, 0] as const } } }
          : b,
      ),
    };
    expect(() => buildSkeletonMesh(broken, context(), { quality: QUALITY_LOW })).toThrow(/femur_r/);
    expect(() => buildSkeletonMesh(broken, context(), { quality: QUALITY_LOW })).toThrow(
      /Right femur/,
    );
  });
});
