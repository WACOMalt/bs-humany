/**
 * HSDL document + fidelity profile + morphology -> `CompiledArticulation` -- milestone M3.4.
 *
 * This is where names become indices and expressions become numbers. Everything downstream works
 * in the index space fixed here, and that space depends only on the document, the profile and the
 * morphology -- never on which backend is loaded (spec section 9.2).
 *
 * Ordering rules, restated because they are the contract:
 *   - segments in the profile's declared order;
 *   - joints in document order, among those the profile activates whose two bones land in
 *     different segments;
 *   - DoFs in each joint's declared order, contiguous across joints, after the root's free joint.
 *
 * What the compiler will not do silently: drop a joint, split a de Leva segment, ignore a
 * constraint or leave a segment unconnected. Every one of those is a note in the report, and the
 * last one is fatal, because an articulation with a floating segment is not one model but two.
 */

import {
  type MassProperties,
  PUBLISHED_MASS_TOLERANCE,
  type ResolvedMorphology,
  combineMassProperties,
  rotateInertia,
  segmentMassProperties,
  validateInertia,
} from '@bs-humany/anthropometry';
import {
  type Transform,
  type Vec3,
  compose,
  frameFromLandmarks,
  invert,
  mat3FromQuat,
  relativeTo,
  scaleMat3,
  sub,
  transformPoint,
  transpose,
  vec3,
} from '@bs-humany/frames';
import {
  type ExprContext,
  type HsdlDocument,
  type JointDef,
  type ScalarExpr,
  type SegmentationDef,
  evaluate,
} from '@bs-humany/hsdl';
import { DATASET_MANIFEST, computeWorldTransforms } from '@bs-humany/skeleton';
import {
  type CompiledArticulation,
  type CompiledConstraint,
  type CompiledDof,
  type CompiledJoint,
  type CompiledProxy,
  type CompiledSegment,
  ROOT_NQ,
  ROOT_NV,
} from './articulation.js';
import type { CompileNote, CompileReport } from './backend.js';
import { DE_LEVA_MAPPINGS, type EndpointEnv } from './massMapping.js';

export interface CompileOptions {
  /** Defaults to standard gravity along -Y. */
  readonly gravity?: Vec3 | undefined;
  /**
   * Relative disagreement between a de Leva segment's measured endpoint distance and the
   * proportion-derived length above which an info note is written. Defaults to 10 percent.
   */
  readonly lengthNoteThreshold?: number | undefined;
}

export interface CompileResult {
  readonly articulation: CompiledArticulation;
  readonly report: CompileReport;
}

/** Thrown when the document cannot become one articulation; the report says why. */
export class CompileError extends Error {
  constructor(
    message: string,
    readonly report: CompileReport,
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

const STANDARD_GRAVITY: Vec3 = { x: 0, y: -9.80665, z: 0 };
/** An unspecified optional passive term. */
const ABSENT = 0;

function evalVec3(
  v: {
    x: Parameters<typeof evaluate>[0];
    y: Parameters<typeof evaluate>[0];
    z: Parameters<typeof evaluate>[0];
  },
  context: ExprContext,
): Vec3 {
  return vec3(evaluate(v.x, context), evaluate(v.y, context), evaluate(v.z, context));
}

function makeReport(notes: CompileNote[], segments: number, joints: number, nv: number) {
  return {
    backend: 'compiler',
    notes,
    hasWarnings: notes.some((n) => n.severity !== 'info'),
    segments,
    joints,
    nv,
  } satisfies CompileReport;
}

/**
 * Compile one profile of a document at one morphology.
 *
 * The document is assumed valid (`assertValidDocument`); this function does not re-run the
 * validator, so cross-reference errors surface as exceptions with less helpful messages.
 */
/** Hull vertices scaled by the proxy's expression, so a measured hull follows stature. */
function convexHullShape(
  vertices: readonly Vec3[],
  scale: ScalarExpr | undefined,
  context: ExprContext,
): CompiledProxy['shape'] {
  const s = scale === undefined ? 1 : evaluate(scale, context);
  return { kind: 'convexHull', vertices: vertices.map((v) => vec3(v.x * s, v.y * s, v.z * s)) };
}

export function compileArticulation(
  document: HsdlDocument,
  profileId: string,
  morphology: ResolvedMorphology,
  options: CompileOptions = {},
): CompileResult {
  const profile = document.segmentation.find((p) => p.id === profileId);
  if (!profile) {
    throw new Error(
      `Document '${document.id}' has no profile '${profileId}'. Profiles: ` +
        `${document.segmentation.map((p) => p.id).join(', ')}.`,
    );
  }
  const context = morphology.context;
  const notes: CompileNote[] = [];
  const fail = (message: string): never => {
    throw new CompileError(message, makeReport(notes, 0, 0, 0));
  };

  // --- Rest pose ------------------------------------------------------------------------------
  const boneWorld = computeWorldTransforms(document, context);
  const boneOf = (id: string): Transform => {
    const t = boneWorld.get(id);
    if (!t) return fail(`Bone '${id}' has no rest transform.`);
    return t;
  };

  // --- Segments -------------------------------------------------------------------------------
  const segmentIndex = new Map<string, number>();
  const segmentOfBone = new Map<string, number>();
  profile.segments.forEach((s, i) => {
    segmentIndex.set(s.id, i);
    for (const b of s.bones) segmentOfBone.set(b, i);
  });
  const segmentRest: Transform[] = profile.segments.map((s) => boneOf(s.anchor));

  // --- Joints and the dynamic tree ------------------------------------------------------------
  const active = new Set(profile.joints ?? document.joints.map((j) => j.id));
  const jointWorldById = new Map<string, { parent: Transform; child: Transform }>();
  for (const joint of document.joints) {
    const parentSide = compose(boneOf(joint.parentBone), {
      translation: evalVec3(joint.frame.translation, context),
      rotation: joint.frame.rotation,
    });
    const childSide = joint.childFrame
      ? compose(boneOf(joint.childBone), {
          translation: evalVec3(joint.childFrame.translation, context),
          rotation: joint.childFrame.rotation,
        })
      : parentSide;
    jointWorldById.set(joint.id, { parent: parentSide, child: childSide });
  }

  const parentOf: number[] = profile.segments.map(() => -1);
  const parentJointOf: (JointDef | undefined)[] = profile.segments.map(() => undefined);
  const compiledJoints: CompiledJoint[] = [];
  const allDofs: CompiledDof[] = [];
  const dofIndexOf = new Map<string, number>(); // `${jointId}/${dofIndex}` -> global index

  for (const joint of document.joints) {
    if (!active.has(joint.id)) continue;
    const a = segmentOfBone.get(joint.parentBone);
    const b = segmentOfBone.get(joint.childBone);
    if (a === undefined || b === undefined) {
      return fail(`Joint '${joint.id}' names a bone no segment of '${profile.id}' owns.`);
    }
    if (a === b) {
      notes.push({
        severity: 'info',
        feature: 'joint',
        element: joint.id,
        message:
          `Joint '${joint.id}' connects two bones of segment ` +
          `'${profile.segments[a]?.id}' and is dropped: the segment is rigid at this fidelity.`,
      });
      continue;
    }
    if (parentOf[b] !== -1) {
      return fail(
        `Segment '${profile.segments[b]?.id}' is the child of both '${parentJointOf[b]?.id}' and ` +
          `'${joint.id}'. A kinematic loop needs a constraint, not a second joint.`,
      );
    }
    parentOf[b] = a;
    parentJointOf[b] = joint;

    const world = jointWorldById.get(joint.id);
    if (!world) return fail(`Joint '${joint.id}' has no world transform.`);
    const parentRest = segmentRest[a];
    const childRest = segmentRest[b];
    if (!parentRest || !childRest) return fail('Segment rest transform missing.');

    const dofStart = allDofs.length;
    const dofs: CompiledDof[] = joint.dofs.map((d, i) => {
      // Values are copied from the document, whose DoFs carry their own citations; an absent
      // passive term contributes nothing.
      const [low, high] = d.range;
      const compiled: CompiledDof = {
        index: dofStart + i,
        joint: compiledJoints.length,
        axisName: d.axis,
        kind: d.kind,
        vector: vec3(d.vector.x, d.vector.y, d.vector.z),
        range: [low, high],
        neutral: d.neutral,
        passiveStiffness: d.passiveStiffness,
        passiveDamping: d.passiveDamping ?? ABSENT,
        armature: d.armature ?? ABSENT,
        frictionLoss: d.frictionLoss ?? ABSENT,
      };
      dofIndexOf.set(`${joint.id}/${i}`, compiled.index);
      return compiled;
    });
    allDofs.push(...dofs);
    compiledJoints.push({
      index: compiledJoints.length,
      id: joint.id,
      displayName: joint.displayName,
      parentSegment: a,
      childSegment: b,
      parentBone: joint.parentBone,
      childBone: joint.childBone,
      frameInParent: relativeTo(world.parent, parentRest),
      frameInChild: relativeTo(world.child, childRest),
      dofs,
      dofStart,
      type: joint.type,
    });
  }

  const roots = parentOf.map((p, i) => (p === -1 ? i : -1)).filter((i) => i !== -1);
  if (roots.length !== 1) {
    const names = roots.map((i) => profile.segments[i]?.id).join(', ');
    for (const i of roots.slice(1)) {
      notes.push({
        severity: 'error',
        feature: 'segment',
        element: profile.segments[i]?.id,
        message: `Segment '${profile.segments[i]?.id}' has no joint connecting it to the tree.`,
      });
    }
    return fail(
      `Profile '${profile.id}' does not compile to one articulation: ${roots.length} segments ` +
        `have no parent joint (${names}). Every segment but the root needs exactly one.`,
    );
  }
  const root = roots[0] as number;

  // --- Mass properties ------------------------------------------------------------------------
  const compiledSegments = compileMassProperties(
    document,
    profile,
    morphology,
    boneWorld,
    jointWorldById,
    segmentRest,
    parentOf,
    notes,
    options.lengthNoteThreshold ?? 0.1,
    fail,
  );

  // --- Proxies --------------------------------------------------------------------------------
  const proxiesById = new Map(document.collisionProxies.map((p) => [p.id, p]));
  const defaultClass = document.contactRules.defaultClass ?? 'default';
  const proxies: CompiledProxy[] = [];
  const proxyIndices: number[][] = profile.segments.map(() => []);
  profile.segments.forEach((segment, si) => {
    for (const id of segment.proxies ?? []) {
      const p = proxiesById.get(id);
      if (!p) return fail(`Segment '${segment.id}' references missing proxy '${id}'.`);
      const shape = p.shape;
      const compiledShape: CompiledProxy['shape'] =
        shape.kind === 'capsule'
          ? {
              kind: 'capsule',
              radius: evaluate(shape.radius, context),
              length: evaluate(shape.length, context),
            }
          : shape.kind === 'sphere'
            ? { kind: 'sphere', radius: evaluate(shape.radius, context) }
            : shape.kind === 'box'
              ? { kind: 'box', halfExtents: evalVec3(shape.halfExtents, context) }
              : convexHullShape(shape.vertices, shape.scale, context);
      proxyIndices[si]?.push(proxies.length);
      proxies.push({
        index: proxies.length,
        id: p.id,
        segment: si,
        transform: {
          translation: evalVec3(p.transform.translation, context),
          rotation: p.transform.rotation,
        },
        shape: compiledShape,
        group: p.group ?? 1,
        mask: p.mask ?? 0xffffffff,
        contactClass: defaultClass,
      });
    }
  });
  if ((document.contactRules.assign ?? []).length > 0) {
    notes.push({
      severity: 'warning',
      feature: 'contactRules.assign',
      message:
        'Per-pair contact class assignment is not compiled yet; every proxy uses the default ' +
        'class.',
    });
  }

  // --- Exclusions -----------------------------------------------------------------------------
  const pairKeys = new Set<string>();
  const excluded: [number, number][] = [];
  const exclude = (a: number, b: number) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (pairKeys.has(key)) return;
    pairKeys.add(key);
    excluded.push(a < b ? [a, b] : [b, a]);
  };
  parentOf.forEach((p, i) => {
    if (p !== -1) exclude(p, i);
  });
  for (const [a, b] of document.contactRules.exclude ?? []) {
    const ia = segmentIndex.get(a);
    const ib = segmentIndex.get(b);
    if (ia !== undefined && ib !== undefined) exclude(ia, ib);
  }
  excluded.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // --- Constraints ----------------------------------------------------------------------------
  const constraints: CompiledConstraint[] = [];
  for (const c of document.constraints) {
    if (c.kind.type === 'jointCoupling') {
      const dependent = dofIndexOf.get(`${c.kind.dependent.joint}/${c.kind.dependent.dof}`);
      const drivers = c.kind.drivers.map((d) => ({
        dof: dofIndexOf.get(`${d.dof.joint}/${d.dof.dof}`),
        coefficient: d.coefficient,
        higher: d.higher,
      }));
      if (dependent === undefined || drivers.some((d) => d.dof === undefined)) {
        // A document carries couplings for every profile; a profile that lumps the joints a
        // coupling ties together has nothing to couple, which is expected rather than a loss.
        notes.push({
          severity: 'info',
          feature: 'constraint',
          element: c.id,
          message: `Constraint '${c.id}' couples joints this profile does not activate; not compiled.`,
        });
        continue;
      }
      constraints.push({
        index: constraints.length,
        id: c.id,
        kind: {
          type: 'jointCoupling',
          dependent,
          drivers: drivers.map((d) => ({
            dof: d.dof as number,
            coefficient: d.coefficient,
            ...(d.higher ? { higher: d.higher } : {}),
          })),
          offset: c.kind.offset ?? 0,
        },
        soft: c.soft ?? false,
      });
    } else {
      const a = segmentOfBone.get(c.kind.bodyA);
      const b = segmentOfBone.get(c.kind.bodyB);
      if (a === undefined || b === undefined || a === b) {
        notes.push({
          severity: a === b ? 'info' : 'warning',
          feature: 'constraint',
          element: c.id,
          message:
            a === b
              ? `Weld '${c.id}' joins two bones of one segment and is already satisfied.`
              : `Weld '${c.id}' names a bone no segment owns, and is dropped.`,
        });
        continue;
      }
      constraints.push({
        index: constraints.length,
        id: c.id,
        kind: { type: 'weld', segmentA: a, segmentB: b },
        soft: c.soft ?? false,
      });
    }
  }

  // --- Assemble -------------------------------------------------------------------------------
  const segments: CompiledSegment[] = compiledSegments.map((s, i) => ({
    ...s,
    proxyIndices: proxyIndices[i] ?? [],
  }));
  const totalMass = segments.reduce((sum, s) => sum + s.mass, 0);
  const target = morphology.input.mass;
  if (Math.abs(totalMass - target) > PUBLISHED_MASS_TOLERANCE * target) {
    return fail(
      `Segment masses sum to ${totalMass.toFixed(4)} kg against a body mass of ${target} kg; ` +
        'the de Leva mapping does not partition the body.',
    );
  }

  const nv = ROOT_NV + allDofs.length;
  const articulation: CompiledArticulation = {
    documentId: document.id,
    profileId: profile.id,
    morphologyKey: morphologyKey(morphology),
    segments,
    joints: compiledJoints,
    dofs: allDofs,
    proxies,
    contactClasses: Object.fromEntries(
      Object.entries(document.contactRules.classes ?? {}).map(([name, c]) => [
        name,
        { friction: c.friction, restitution: c.restitution, softness: c.softness ?? 0 },
      ]),
    ),
    excludedPairs: excluded,
    constraints,
    nv,
    nq: ROOT_NQ + allDofs.length,
    root,
    gravity: options.gravity ?? STANDARD_GRAVITY,
    totalMass,
  };
  return { articulation, report: makeReport(notes, segments.length, compiledJoints.length, nv) };
}

/** A stable key for the morphology inputs, so two compilations can be told apart. */
export function morphologyKey(morphology: ResolvedMorphology): string {
  const { sex, stature, mass } = morphology.input;
  const overrides = morphology.input.proportions
    ? `|${JSON.stringify(morphology.input.proportions)}`
    : '';
  return `sex=${sex}|stature=${stature}|mass=${mass}${overrides}`;
}

// ---------------------------------------------------------------------------------------------
// Mass properties
// ---------------------------------------------------------------------------------------------

type SegmentWithoutProxies = Omit<CompiledSegment, 'proxyIndices'>;

function compileMassProperties(
  document: HsdlDocument,
  profile: SegmentationDef,
  morphology: ResolvedMorphology,
  boneWorld: Map<string, Transform>,
  jointWorldById: Map<string, { parent: Transform; child: Transform }>,
  segmentRest: readonly Transform[],
  parentOf: readonly number[],
  notes: CompileNote[],
  lengthNoteThreshold: number,
  fail: (message: string) => never,
): SegmentWithoutProxies[] {
  const context = morphology.context;
  const scale = morphology.input.stature / DATASET_MANIFEST.subjectStature;
  const landmarkById = new Map(document.landmarks.map((l) => [l.id, l]));
  const packed = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b]));

  const env: EndpointEnv = {
    landmark(id) {
      const l = landmarkById.get(id);
      if (!l) return fail(`Mass mapping references landmark '${id}', which the document lacks.`);
      const bone = boneWorld.get(l.bone);
      if (!bone) return fail(`Landmark '${id}' is on '${l.bone}', which has no rest transform.`);
      return transformPoint(bone, evalVec3(l.position, context));
    },
    joint(id) {
      const j = jointWorldById.get(id);
      if (!j) return fail(`Mass mapping references joint '${id}', which the document lacks.`);
      return j.parent.translation;
    },
    bounds(bones) {
      let min: Vec3 | undefined;
      let max: Vec3 | undefined;
      for (const id of bones) {
        const b = packed.get(id);
        if (!b) continue;
        const lo = vec3(b.min[0] * scale, b.min[1] * scale, b.min[2] * scale);
        const hi = vec3(b.max[0] * scale, b.max[1] * scale, b.max[2] * scale);
        min = min ? vec3(Math.min(min.x, lo.x), Math.min(min.y, lo.y), Math.min(min.z, lo.z)) : lo;
        max = max ? vec3(Math.max(max.x, hi.x), Math.max(max.y, hi.y), Math.max(max.z, hi.z)) : hi;
      }
      if (!min || !max) return fail(`No packed bounds among bones ${bones.join(', ')}.`);
      return { min, max };
    },
  };

  // Which bones each de Leva part owns, and which profile segment owns each bone.
  const segmentOfBone = new Map<string, number>();
  profile.segments.forEach((s, i) => {
    for (const b of s.bones) segmentOfBone.set(b, i);
  });

  const parts: MassProperties[][] = profile.segments.map(() => []);
  const unmapped = new Set(document.bones.map((b) => b.id));

  for (const mapping of DE_LEVA_MAPPINGS) {
    const bones = document.bones.filter(mapping.bones).map((b) => b.id);
    for (const id of bones) unmapped.delete(id);
    if (bones.length === 0) continue;

    const proximal = mapping.proximal(env, bones);
    const distal = mapping.distal(env, bones);
    const axisLength = Math.hypot(
      distal.x - proximal.x,
      distal.y - proximal.y,
      distal.z - proximal.z,
    );
    const whole = segmentMassProperties(
      morphology.inertialTable[mapping.segment],
      morphology.input.mass,
      axisLength,
    );
    const expected = morphology.segmentLengths[mapping.segment];
    if (Math.abs(axisLength - expected) / expected > lengthNoteThreshold) {
      notes.push({
        severity: 'info',
        feature: 'segmentLength',
        element: mapping.segment + (mapping.side ? `_${mapping.side}` : ''),
        message:
          `de Leva segment '${mapping.segment}' measures ${axisLength.toFixed(3)} m between its ` +
          `endpoints on this skeleton against ${expected.toFixed(3)} m from the proportion ` +
          'table; the measured length is used. See OQ-003.',
      });
    }

    // Frame with Y along the axis toward the proximal end and X toward the subject's right.
    const frame = frameFromLandmarks({
      origin: proximal,
      primaryDirection: sub(proximal, distal),
      primaryAxis: 'y',
      secondaryDirection: vec3(1, 0, 0),
      secondaryAxis: 'x',
    });
    const rotation = mat3FromQuat(frame.rotation);
    const inertiaWorld = rotateInertia(whole.inertia, rotation);
    const comWorld = transformPoint(frame, whole.com);

    // Split by owning profile segment.
    const owners = new Map<number, string[]>();
    for (const id of bones) {
      const s = segmentOfBone.get(id);
      if (s === undefined) return fail(`Bone '${id}' belongs to no segment of '${profile.id}'.`);
      owners.set(s, [...(owners.get(s) ?? []), id]);
    }
    if (owners.size === 1) {
      const [only] = owners.keys();
      parts[only as number]?.push({ mass: whole.mass, com: comWorld, inertia: inertiaWorld });
      continue;
    }

    const volume = (ids: readonly string[]) => {
      const b = env.bounds(ids);
      return (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
    };
    const volumes = [...owners.entries()].map(([s, ids]) => [s, ids, volume(ids)] as const);
    const total = volumes.reduce((sum, [, , v]) => sum + v, 0);
    for (const [s, ids, v] of volumes) {
      const fraction = v / total;
      const b = env.bounds(ids);
      const centre = vec3(
        (b.min.x + b.max.x) / 2,
        (b.min.y + b.max.y) / 2,
        (b.min.z + b.max.z) / 2,
      );
      parts[s]?.push({
        mass: whole.mass * fraction,
        com: centre,
        inertia: scaleMat3(inertiaWorld, fraction),
      });
      notes.push({
        severity: 'warning',
        feature: 'massProperties',
        element: profile.segments[s]?.id,
        message:
          `Segment '${profile.segments[s]?.id}' takes ${(fraction * 100).toFixed(1)}% of de Leva's ` +
          `'${mapping.segment}${mapping.side ? `_${mapping.side}` : ''}' by the bulk of the bones ` +
          'it owns, with the centre of mass at the centre of that bulk. Approximation, not ' +
          'measurement.',
      });
    }
  }
  if (unmapped.size > 0) {
    return fail(`Bones without a de Leva mapping: ${[...unmapped].join(', ')}.`);
  }

  return profile.segments.map((segment, i): SegmentWithoutProxies => {
    const own = parts[i] ?? [];
    if (own.length === 0) return fail(`Segment '${segment.id}' received no mass.`);
    const combined = combineMassProperties(own);
    const rest = segmentRest[i];
    if (!rest) return fail('Segment rest transform missing.');
    const toSegment = invert(rest);
    const com = transformPoint(toSegment, combined.com);
    const inertia = rotateInertia(combined.inertia, transpose(mat3FromQuat(rest.rotation)));
    const check = validateInertia(inertia);
    if (!check.valid) {
      return fail(
        `Segment '${segment.id}' has an invalid inertia tensor: ${check.problems.join('; ')}.`,
      );
    }
    const anchorWorld = rest;
    const followers = segment.bones
      .filter((b) => b !== segment.anchor)
      .map((bone) => {
        const t = boneWorld.get(bone);
        if (!t) return fail(`Bone '${bone}' has no rest transform.`);
        return { bone, local: relativeTo(t, anchorWorld) };
      });
    return {
      index: i,
      id: segment.id,
      displayName: segment.displayName,
      anchor: segment.anchor,
      bones: [segment.anchor, ...segment.bones.filter((b) => b !== segment.anchor)],
      parent: parentOf[i] ?? -1,
      restWorld: rest,
      mass: combined.mass,
      com,
      inertia,
      followers,
    };
  });
}
