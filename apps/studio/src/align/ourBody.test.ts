/**
 * Our body at rest, as the Align tab reads it, on the L3 reference profile.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import { transformPoint } from '@bs-humany/frames';
import { compileMuscleSet } from '@bs-humany/modules-muscle';
import { ALL_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { attachmentSites, jointsOnSegment, restJointCentre } from './ourBody.js';
import { PointHandles } from './pointHandles.js';

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
