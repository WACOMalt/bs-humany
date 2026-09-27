/**
 * Their bones on ours: the suggestions by name, and the fits, on the real reference models.
 *
 * Built on the L3 reference profile and the committed `sourceSites.json`, so these are the
 * answers the Align tab gives a person, not answers to a toy. Each check is one a person made by
 * eye in the studio and found wrong: the pelvis pitched a quarter turn over, the arm fitted at
 * the feet, the torso's lumbar column suggested nothing.
 */

import { readFileSync } from 'node:fs';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import { buildDocument } from '@bs-humany/skeleton';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { jointsOnSegment, restJointCentre } from './ourBody.js';
import { type BodyFit, fitBodies, fittedFromPlacement, suggestBodyPairs } from './retarget.js';
import {
  NEUTRAL,
  type Placement,
  type SourceModel,
  SourceOverlay,
  type SourceSites,
  defaultPlacement,
} from './sourceOverlay.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
const SEGMENTS = articulation.segments.map((s) => s.id);
const SITES = JSON.parse(
  readFileSync(new URL('../../public/sourceSites.json', import.meta.url), 'utf8'),
) as SourceSites;
const ourJointsOn = (segment: string) => jointsOnSegment(articulation, segment);

const modelNamed = (name: string): SourceModel => {
  const model = SITES.models[name];
  if (!model) throw new Error(`sourceSites.json has no ${name} model`);
  return model;
};

/** The fit of one of their bodies with its suggested pairs, from the model's default placement. */
const fitWithSuggestions = (name: string) => {
  const model = modelNamed(name);
  return fitBodies(
    model,
    suggestBodyPairs(model, SEGMENTS),
    articulation,
    ourJointsOn,
    fittedFromPlacement(defaultPlacement(name)),
  );
};

const fitOf = (fits: ReadonlyMap<string, BodyFit>, theirs: string): BodyFit => {
  const fit = fits.get(theirs);
  if (!fit) throw new Error(`${theirs} was not fitted`);
  return fit;
};

const jointNamed = (id: string) => {
  const joint = articulation.joints.find((j) => j.id === id);
  if (!joint) throw new Error(`the L3 body has no joint ${id}`);
  return joint;
};

describe('suggestions by name', () => {
  const suggested = (name: string) =>
    Object.fromEntries(suggestBodyPairs(modelNamed(name), SEGMENTS).map((p) => [p.theirs, p.ours]));

  it('pairs the legs bone for bone, all but the toes', () => {
    expect(suggested('legs')).toEqual({
      pelvis: 'pelvis',
      femur_r: 'thigh_r',
      tibia_r: 'shank_r',
      talus_r: 'talus_r',
      calcn_r: 'calcaneus_r',
      patella_r: 'patella_r',
      femur_l: 'thigh_l',
      tibia_l: 'shank_l',
      talus_l: 'talus_l',
      calcn_l: 'calcaneus_l',
      patella_l: 'patella_l',
    });
  });

  it('pairs the arm from the clavicle to the forearm', () => {
    expect(suggested('arm')).toEqual({
      clavicle_r: 'clavicle_r',
      scapula_r: 'scapula_r',
      humerus_r: 'upperarm_r',
      ulna_r: 'ulna_r',
      radius_r: 'radius_r',
    });
  });

  it('pairs the sacrum, the lumbar column and the head, and none of the torso lumps', () => {
    expect(suggested('torso')).toEqual({
      sacrum: 'pelvis',
      lumbar5: 'l5',
      lumbar4: 'l4',
      lumbar3: 'l3',
      lumbar2: 'l2',
      lumbar1: 'l1',
      head: 'head',
    });
  });
});

describe('the default placement', () => {
  /**
   * A line down each model, top to bottom, by its own bodies. Every model in the file has to be
   * here, so a new one cannot arrive without someone saying which way is down in it.
   */
  const DOWN: Record<string, [string, string]> = {
    arm: ['clavicle_r', 'distph3_r'],
    legs: ['pelvis', 'toes_r'],
    torso: ['head', 'sacrum'],
  };

  it('stands every model up with its long axis down our -Y', () => {
    expect(Object.keys(SITES.models).sort()).toEqual(Object.keys(DOWN).sort());
    for (const [name, [top, bottom]] of Object.entries(DOWN)) {
      const model = modelNamed(name);
      const at = (body: string) => {
        const pos = model.bodies.find((b) => b.name === body)?.pos;
        if (!pos) throw new Error(`${name} has no body ${body}`);
        return new Vector3(pos[0], pos[1], pos[2]);
      };
      const down = at(bottom)
        .sub(at(top))
        .normalize()
        .applyQuaternion(fittedFromPlacement(defaultPlacement(name)).rotation);
      expect(down.dot(new Vector3(0, -1, 0)), name).toBeGreaterThan(0.9);
    }
  });

  it('means what the overlay means by a placement', () => {
    const p: Placement = { x: 0.3, y: -0.2, z: 0.7, rx: -90, ry: 25, rz: 180, scale: 1.2 };
    const overlay = new SourceOverlay();
    overlay.place(p);
    overlay.group.updateMatrixWorld(true);
    const fit = fittedFromPlacement(p);
    for (const point of [new Vector3(0.1, 0.2, 0.3), new Vector3(-0.4, 0, 0.05)]) {
      const drawn = point.clone().applyMatrix4(overlay.group.matrixWorld);
      const fitted = point
        .clone()
        .multiplyScalar(fit.scale)
        .applyQuaternion(fit.rotation)
        .add(fit.position);
      expect(drawn.distanceTo(fitted)).toBeLessThan(1e-12);
    }
    overlay.dispose();
  });
});

describe('fits on the real models', () => {
  it('stands the pelvis up and lines the knee up with ours', () => {
    const { fits } = fitWithSuggestions('legs');
    // Their pelvis is Z-up; on ours, its up has to be our up.
    const up = new Vector3(0, 0, 1).applyQuaternion(fitOf(fits, 'pelvis').rotation);
    expect(up.dot(new Vector3(0, 1, 0))).toBeGreaterThan(0.95);

    // Their knee's flexion axis, carried by the tibia's fit, against our knee's hinge.
    const theirKnee = modelNamed('legs').joints.find((j) => j.name === 'knee_angle_r');
    if (!theirKnee) throw new Error('the legs have no knee_angle_r');
    const theirs = new Vector3(...(theirKnee.axis as [number, number, number]))
      .normalize()
      .applyQuaternion(fitOf(fits, 'tibia_r').rotation);
    const knee = jointNamed('knee_r');
    const hinge =
      knee.dofs.find((d) => d.kind === 'hinge' && d.axisName === 'flexion') ??
      knee.dofs.find((d) => d.kind === 'hinge');
    const thigh = articulation.segments[knee.parentSegment];
    if (!hinge || !thigh) throw new Error('our knee has no hinge');
    const r = thigh.restWorld.rotation;
    const f = knee.frameInParent.rotation;
    const ours = new Vector3(hinge.vector.x, hinge.vector.y, hinge.vector.z).applyQuaternion(
      new Quaternion(r.x, r.y, r.z, r.w).multiply(new Quaternion(f.x, f.y, f.z, f.w)),
    );
    const degrees = (Math.acos(Math.min(1, Math.abs(theirs.dot(ours)))) * 180) / Math.PI;
    expect(degrees).toBeLessThan(10);
  });

  it('puts the arm on our shoulder, through the phantoms between its bones', () => {
    const { fits } = fitWithSuggestions('arm');
    for (const bone of ['scapula_r', 'humerus_r']) {
      const fit = fitOf(fits, bone);
      expect(fit.matched, bone).toBeGreaterThanOrEqual(2);
      expect(['model', 'inherited'], bone).not.toContain(fit.kind);
    }
    // The clavicle meets only the scapula, so its turn is the placement's.
    const root = fittedFromPlacement(defaultPlacement('arm'));
    expect(fitOf(fits, 'clavicle_r').rotation.angleTo(root.rotation)).toBeLessThan(1e-9);
    const shoulder = restJointCentre(articulation, jointNamed('glenohumeral_r'), 'parent');
    for (const fit of fits.values()) {
      expect(fit.position.distanceTo(shoulder), fit.theirs).toBeLessThan(0.5);
    }
  });
});

describe('the overall scale', () => {
  /**
   * A model made of our own body shrunk about the origin: our segments as their bodies, our
   * joint centres times `factor` as their joints, and one loose body that meets nothing.
   */
  const shrunk = (factor: number, keep: (segment: string) => boolean): SourceModel => {
    const kept = articulation.segments.filter((s) => keep(s.id));
    const ids = new Set(kept.map((s) => s.id));
    const parentOf = (index: number): string | null => {
      let at = articulation.segments[index]?.parent ?? -1;
      while (at >= 0 && !ids.has(articulation.segments[at]?.id ?? '')) {
        at = articulation.segments[at]?.parent ?? -1;
      }
      return at >= 0 ? (articulation.segments[at]?.id ?? null) : null;
    };
    return {
      muscles: [],
      bodies: [
        ...kept.map((s) => ({
          name: s.id,
          parent: parentOf(s.index),
          meshes: [{ file: 'x.stl', pos: [0, 0, 0], quat: [1, 0, 0, 0] }],
          pos: [0, 0, 0],
          quat: [1, 0, 0, 0],
        })),
        { name: 'loose', parent: null, meshes: [], pos: [0, 0, 0], quat: [1, 0, 0, 0] },
      ],
      joints: articulation.joints
        .filter((j) => ids.has(articulation.segments[j.childSegment]?.id ?? ''))
        .filter((j) => ids.has(articulation.segments[j.parentSegment]?.id ?? ''))
        .map((j) => ({
          name: j.id,
          body: articulation.segments[j.childSegment]?.id ?? null,
          anchor: restJointCentre(articulation, j, 'child').multiplyScalar(factor).toArray(),
          axis: [1, 0, 0],
        })),
    };
  };
  const pairsOf = (model: SourceModel) =>
    model.bodies.map((b) => ({ theirs: b.name, ours: b.name === 'loose' ? 'head' : b.name }));

  it('measures a model nine tenths our size as 1/0.9, and sizes an unmatched bone by it', () => {
    const legs = new Set([
      'pelvis',
      'thigh_r',
      'shank_r',
      'talus_r',
      'thigh_l',
      'shank_l',
      'talus_l',
    ]);
    const model = shrunk(0.9, (s) => legs.has(s));
    const result = fitBodies(
      model,
      pairsOf(model),
      articulation,
      ourJointsOn,
      fittedFromPlacement(NEUTRAL),
    );
    expect(result.overallMeasured).toBe(true);
    expect(result.overallScale).toBeCloseTo(1 / 0.9, 9);
    const loose = fitOf(result.fits, 'loose');
    expect(loose.kind).toBe('model');
    expect(loose.scale).toBeCloseTo(1 / 0.9, 9);
  });

  it('keeps the placement scale when every span is too short to measure', () => {
    const model = shrunk(0.9, (s) => s === 'l5' || s === 'l4');
    const result = fitBodies(
      model,
      pairsOf(model),
      articulation,
      ourJointsOn,
      fittedFromPlacement(NEUTRAL),
    );
    expect(result.overallMeasured).toBe(false);
    expect(result.overallScale).toBe(1);
    expect(fitOf(result.fits, 'loose').scale).toBe(1);
  });
});
