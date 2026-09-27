/**
 * Our body at rest, as the Align tab reads it, on the L3 reference profile, and the reference
 * models seated on it from the committed `sourceSites.json`.
 */

import { readFileSync } from 'node:fs';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import { transformPoint } from '@bs-humany/frames';
import { compileMuscleSet } from '@bs-humany/modules-muscle';
import { ALL_MUSCLES, ELBOW_UNITS } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  attachmentSites,
  jointsOnSegment,
  restJointCentre,
  seatReferenceModel,
  viaPoints,
} from './ourBody.js';
import { PointHandles } from './pointHandles.js';
import { fittedFromPlacement } from './retarget.js';
import type { Placement, SourceSites } from './sourceOverlay.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
const muscles = compileMuscleSet(
  [...ALL_MUSCLES],
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);

describe('our body at rest', () => {
  it('puts every joint centre in one place whichever side it is read from', () => {
    for (const joint of articulation.joints) {
      const parent = restJointCentre(articulation, joint, 'parent');
      const child = restJointCentre(articulation, joint, 'child');
      expect(parent.distanceTo(child), joint.id).toBeLessThan(1e-6);
    }
  });

  it('gives the point handles the same joint centres', () => {
    const handles = PointHandles.jointsOf(articulation);
    expect(handles).toHaveLength(articulation.joints.length);
    for (const [i, joint] of articulation.joints.entries()) {
      const h = handles[i];
      expect(h?.id).toBe(joint.id);
      expect(h?.world.distanceTo(restJointCentre(articulation, joint, 'parent'))).toBe(0);
    }
  });

  it('finds the hip and the knee on the right thigh, each with the segment across it', () => {
    const joints = jointsOnSegment(articulation, 'thigh_r');
    const hip = articulation.joints.find((j) => j.id === 'hip_r');
    const knee = articulation.joints.find((j) => j.id === 'knee_r');
    if (!hip || !knee) throw new Error('the L3 body has no hip_r or knee_r');
    const across = joints.map((j) => j.other).sort();
    expect(across).toContain('pelvis');
    expect(across).toContain('shank_r');
    const atHip = joints.find((j) => j.other === 'pelvis');
    const atKnee = joints.find((j) => j.other === 'shank_r');
    expect(atHip?.at.distanceTo(restJointCentre(articulation, hip, 'child'))).toBeLessThan(1e-9);
    expect(atKnee?.at.distanceTo(restJointCentre(articulation, knee, 'parent'))).toBeLessThan(1e-9);
    expect(jointsOnSegment(articulation, 'no_such_segment')).toEqual([]);
  });

  it('places both ends of every muscle path, each on the segment that carries its bone', () => {
    const sites = attachmentSites(articulation, muscles);
    expect(sites).toHaveLength(2 * muscles.paths.length);
    const ids = new Set(sites.map((s) => s.id));
    expect(ids.size).toBe(sites.length);
    for (const path of muscles.paths) {
      expect(ids.has(`${path.id}:origin`)).toBe(true);
      expect(ids.has(`${path.id}:insertion`)).toBe(true);
    }
    const segments = new Set(articulation.segments.map((s) => s.id));
    for (const s of sites) expect(segments.has(s.segment), s.id).toBe(true);
    expect(attachmentSites(articulation, undefined)).toEqual([]);
  });

  it("puts a follower bone's site through its own frame, not the segment's", () => {
    // The fibula is on the shank but is not its anchor, so its sites are stated in a frame the
    // segment's rest pose alone does not reach.
    const shank = articulation.segments.find((s) => s.id === 'shank_r');
    const follower = shank?.followers.find((f) => f.bone === 'fibula_r');
    const path = muscles.paths.find(
      (p) => p.origin.bone === 'fibula_r' || p.insertion.bone === 'fibula_r',
    );
    if (!shank || !follower || !path) throw new Error('no muscle on the right fibula to check');
    const end = path.origin.bone === 'fibula_r' ? 'origin' : 'insertion';
    const site = attachmentSites(articulation, muscles).find((s) => s.id === `${path.id}:${end}`);
    const inShank = transformPoint(follower.local, path[end].point);
    const want = transformPoint(shank.restWorld, inShank);
    expect(site?.segment).toBe('shank_r');
    expect(site?.bone).toBe('fibula_r');
    expect(
      Math.hypot(
        want.x - (site?.world.x ?? 0),
        want.y - (site?.world.y ?? 0),
        want.z - (site?.world.z ?? 0),
      ),
    ).toBeLessThan(1e-9);
  });
});

describe('via points', () => {
  it('gives every non-wrapping path element of the L3 set exactly one via point', () => {
    const want = muscles.paths.reduce(
      (n, path) => n + path.elements.filter((e) => e.kind !== 'wrap').length,
      0,
    );
    const vias = viaPoints(articulation, muscles);
    expect(want).toBeGreaterThan(0);
    expect(vias).toHaveLength(want);
    expect(new Set(vias.map((v) => v.id)).size).toBe(vias.length);
    expect(viaPoints(articulation, undefined)).toEqual([]);
  });

  it("numbers the long biceps's via points one to one onto its via sites, wraps skipped", () => {
    const unit = ELBOW_UNITS.find((u) => u.id === 'biceps_brachii_long_r');
    if (!unit) throw new Error('elbow.ts has no biceps_brachii_long_r');
    const siteNames = unit.path.flatMap((e) => (e.kind === 'wrap' ? [] : [e.site]));
    expect(siteNames.every((n) => n.startsWith('biceps_brachii_long_r__via_'))).toBe(true);
    const vias = viaPoints(articulation, muscles).filter((v) =>
      v.id.startsWith('biceps_brachii_long_r:via'),
    );
    expect(vias.map((v) => v.id)).toEqual(
      siteNames.map((_, i) => `biceps_brachii_long_r:via${i + 1}`),
    );
    const byId = new Map(document.attachmentSites.map((site) => [site.id, site]));
    for (const [i, via] of vias.entries()) {
      expect(via.bone).toBe(byId.get(siteNames[i] as string)?.bone);
    }
  });
});

describe('seating a reference model on our body', () => {
  const sites = JSON.parse(
    readFileSync(new URL('../../public/sourceSites.json', import.meta.url), 'utf8'),
  ) as SourceSites;
  /** Where a point of theirs lands under a placement: scaled, turned, moved, as `place` does. */
  const placed = (p: Placement, point: readonly number[]): Vector3 => {
    const fit = fittedFromPlacement(p);
    return new Vector3(point[0], point[1], point[2])
      .multiplyScalar(fit.scale)
      .applyQuaternion(fit.rotation)
      .add(fit.position);
  };
  const bodyAt = (model: string, name: string): readonly number[] => {
    const body = sites.models[model]?.bodies.find((b) => b.name === name);
    if (!body) throw new Error(`the ${model} model has no body ${name}`);
    return body.pos;
  };
  const jointAt = (id: string): Vector3 => {
    const joint = articulation.joints.find((j) => j.id === id);
    if (!joint) throw new Error(`the L3 body has no joint ${id}`);
    return restJointCentre(articulation, joint, 'parent');
  };
  const midpoint = (a: Vector3, b: Vector3) => a.clone().add(b).multiplyScalar(0.5);
  /** Their long axis, from a body at the top to one below it, as placed: it must run down -Y. */
  const runsDown = (model: string, p: Placement, top: string, bottom: string) => {
    const axis = placed(p, bodyAt(model, bottom))
      .sub(placed(p, bodyAt(model, top)))
      .normalize();
    expect(axis.dot(new Vector3(0, -1, 0)), `${model} ${top} to ${bottom}`).toBeGreaterThan(0.95);
  };

  it('sits the legs by their hip centres on ours, sized by hip-to-knee', () => {
    const seat = seatReferenceModel('legs', sites.models.legs, articulation);
    expect(seat.seated).toBe(true);
    const theirs = midpoint(
      placed(seat.placement, bodyAt('legs', 'femur_r')),
      placed(seat.placement, bodyAt('legs', 'femur_l')),
    );
    const ours = midpoint(jointAt('hip_r'), jointAt('hip_l'));
    expect(theirs.distanceTo(ours)).toBeLessThan(0.003);
    // Sized by the thigh: their hip-to-knee, placed, is as long as ours. The knee itself need not
    // land on ours, because the two thighs do not hang at the same angle from the hip.
    const thigh = (side: 'r' | 'l') =>
      placed(seat.placement, bodyAt('legs', `tibia_${side}`)).distanceTo(
        placed(seat.placement, bodyAt('legs', `femur_${side}`)),
      );
    const ourThigh = (side: 'r' | 'l') =>
      jointAt(`knee_${side}`).distanceTo(jointAt(`hip_${side}`));
    // Within half a millimetre: the scale is measured between the midpoints of the two sides.
    expect((thigh('r') + thigh('l')) / 2).toBeCloseTo((ourThigh('r') + ourThigh('l')) / 2, 3);
    expect(seat.placement.scale).not.toBe(1);
    runsDown('legs', seat.placement, 'femur_r', 'tibia_r');
    expect(seat.how).toMatch(/Seated automatically.*hip-to-knee/);
  });

  it('sits the torso by L5/S1 on our lumbosacral joint', () => {
    const seat = seatReferenceModel('torso', sites.models.torso, articulation);
    expect(seat.seated).toBe(true);
    expect(
      placed(seat.placement, bodyAt('torso', 'lumbar5')).distanceTo(jointAt('l5_s1')),
    ).toBeLessThan(0.003);
    runsDown('torso', seat.placement, 'lumbar1', 'lumbar5');
  });

  it('sits the arm by its humeral head on our right shoulder centre', () => {
    const seat = seatReferenceModel('arm', sites.models.arm, articulation);
    expect(seat.seated).toBe(true);
    expect(
      placed(seat.placement, bodyAt('arm', 'humerus_r')).distanceTo(jointAt('glenohumeral_r')),
    ).toBeLessThan(0.003);
    runsDown('arm', seat.placement, 'humerus_r', 'ulna_r');
  });

  it('keeps the change of axes alone, and says why, with no body to sit on', () => {
    const seat = seatReferenceModel('arm', sites.models.arm, undefined);
    expect(seat.seated).toBe(false);
    expect(seat.placement).toEqual({ x: 0, y: 0, z: 0, rx: 0, ry: 90, rz: 0, scale: 1 });
    expect(seat.how).toMatch(/Start sim/);
  });

  it('still seats the torso on the L0 body, at its own size, since L0 has no L1/L2', () => {
    const l0 = compileArticulation(document, 'l0_ragdoll', morphology).articulation;
    const seat = seatReferenceModel('torso', sites.models.torso, l0);
    expect(seat.seated).toBe(true);
    expect(seat.placement.scale).toBe(1);
    const lumbosacral = l0.joints.find((j) => j.id === 'lumbar_region_lower');
    if (!lumbosacral) throw new Error('the L0 body has no lumbar_region_lower');
    expect(
      placed(seat.placement, bodyAt('torso', 'lumbar5')).distanceTo(
        restJointCentre(l0, lumbosacral, 'parent'),
      ),
    ).toBeLessThan(0.003);
  });
});
