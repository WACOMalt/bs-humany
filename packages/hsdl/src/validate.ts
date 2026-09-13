/**
 * Document validation.
 *
 * Zod checks that each node is *shaped* correctly. This file checks that the document is
 * *coherent*: that every reference resolves, that the bone tree is a tree, and that each
 * segmentation partitions the bones exactly.
 *
 * The error messages are the point. A validation failure here is almost always a data-entry
 * mistake in a file with hundreds of near-identical entries, so every message names the offending
 * ID, says what was expected, and where practical suggests the likely cause. "Invalid document" in
 * a 206-bone file is not a usable diagnostic.
 */

import { type HsdlDocument, HsdlDocumentSchema } from './document.js';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  readonly severity: IssueSeverity;
  /** Dotted path into the document, e.g. `bones[12].parent`. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Present only when `ok` is true. */
  readonly document?: HsdlDocument;
}

/** Parse and fully validate an unknown value as an HSDL document. */
export function validateDocument(input: unknown): ValidationResult {
  const parsed = HsdlDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        severity: 'error' as const,
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }

  const issues = checkCoherence(parsed.data);
  const hasError = issues.some((i) => i.severity === 'error');
  return hasError ? { ok: false, issues } : { ok: true, issues, document: parsed.data };
}

/** Validate, throwing a readable aggregate error. For use at authoring time and in tests. */
export function assertValidDocument(input: unknown): HsdlDocument {
  const result = validateDocument(input);
  if (!result.ok || !result.document) {
    const lines = result.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `  ${i.path}: ${i.message}`);
    throw new Error(`HSDL document is invalid:\n${lines.join('\n')}`);
  }
  return result.document;
}

/**
 * Cross-reference and structural checks that Zod cannot express node-locally.
 */
export function checkCoherence(doc: HsdlDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  const boneIds = new Set<string>();
  doc.bones.forEach((bone, index) => {
    if (boneIds.has(bone.id)) {
      error(
        `bones[${index}].id`,
        `Duplicate bone ID '${bone.id}'. Bone IDs are the project's public ABI and must be unique.`,
      );
    }
    boneIds.add(bone.id);
  });

  // --- Bone tree -----------------------------------------------------------------------------

  const roots: string[] = [];
  for (const [index, bone] of doc.bones.entries()) {
    if (bone.parent === null) {
      roots.push(bone.id);
      continue;
    }
    if (!boneIds.has(bone.parent)) {
      error(
        `bones[${index}].parent`,
        `Bone '${bone.id}' names parent '${bone.parent}', which does not exist. Check for a typo ` +
          'or a missing side suffix (_r / _l).',
      );
    }
  }

  if (roots.length === 0) {
    error('bones', 'No root bone: every bone names a parent, so the skeleton has no anchor.');
  } else if (roots.length > 1) {
    error(
      'bones',
      `The skeleton has ${roots.length} roots (${roots.join(', ')}). A body is a single ` +
        'kinematic tree, so exactly one bone may have a null parent.',
    );
  }

  const cycle = findCycle(doc);
  if (cycle) {
    error(
      'bones',
      `The bone hierarchy contains a cycle: ${cycle.join(' -> ')}. The anatomical parent ` +
        'relation must form a tree.',
    );
  }

  // --- Landmarks -----------------------------------------------------------------------------

  const landmarkIds = new Set<string>();
  doc.landmarks.forEach((landmark, index) => {
    if (landmarkIds.has(landmark.id)) {
      error(`landmarks[${index}].id`, `Duplicate landmark ID '${landmark.id}'.`);
    }
    landmarkIds.add(landmark.id);
    if (!boneIds.has(landmark.bone)) {
      error(
        `landmarks[${index}].bone`,
        `Landmark '${landmark.id}' sits on bone '${landmark.bone}', which does not exist.`,
      );
    }
    if (landmark.source.provisional) {
      warn(
        `landmarks[${index}].source`,
        `Landmark '${landmark.id}' has no cited source and is recorded against open question ` +
          `${landmark.source.provisional.openQuestion}. Landmarks propagate into bone frames, ` +
          'joint centres and every joint definition, so this one is worth closing.',
      );
    }
  });

  // --- Bone frames ---------------------------------------------------------------------------

  doc.bones.forEach((bone, index) => {
    if (!bone.frame) return;
    const referenced = [
      bone.frame.origin,
      bone.frame.primaryFrom,
      bone.frame.primaryTo,
      bone.frame.secondaryFrom,
      bone.frame.secondaryTo,
    ];
    for (const landmarkId of referenced) {
      if (!landmarkIds.has(landmarkId)) {
        error(
          `bones[${index}].frame`,
          `Bone '${bone.id}' builds its frame from landmark '${landmarkId}', which does not exist.`,
        );
      }
    }
    if (bone.frame.primaryFrom === bone.frame.primaryTo) {
      error(
        `bones[${index}].frame`,
        `Bone '${bone.id}' names the same landmark for both ends of its primary axis, so the ` +
          'axis direction is undefined.',
      );
    }
    if (bone.frame.secondaryFrom === bone.frame.secondaryTo) {
      error(
        `bones[${index}].frame`,
        `Bone '${bone.id}' names the same landmark for both ends of its secondary direction, so ` +
          'the roll about the primary axis is undefined.',
      );
    }
  });

  // --- Joints --------------------------------------------------------------------------------

  const jointIds = new Set<string>();
  doc.joints.forEach((joint, index) => {
    if (jointIds.has(joint.id)) {
      error(`joints[${index}].id`, `Duplicate joint ID '${joint.id}'.`);
    }
    jointIds.add(joint.id);

    for (const [role, boneId] of [
      ['parentBone', joint.parentBone],
      ['childBone', joint.childBone],
    ] as const) {
      if (!boneIds.has(boneId)) {
        error(
          `joints[${index}].${role}`,
          `Joint '${joint.id}' names ${role} '${boneId}', which does not exist.`,
        );
      }
    }

    const dofNames = new Set<string>();
    joint.dofs.forEach((dof, dofIndex) => {
      if (dofNames.has(dof.axis)) {
        error(
          `joints[${index}].dofs[${dofIndex}].axis`,
          `Joint '${joint.id}' has two DoFs both named '${dof.axis}'. DoF names are how a UI ` +
            'labels a control and how a report names a value, so they must be distinct.',
        );
      }
      dofNames.add(dof.axis);

      if (dof.passiveStiffness && dof.passiveDamping === undefined) {
        warn(
          `joints[${index}].dofs[${dofIndex}]`,
          `DoF '${joint.id}.${dof.axis}' has end-range stiffness but no viscous damping. ` +
            'Undamped exponential end-stops store and return energy, which reads as a limb ' +
            'bouncing off its own joint limit.',
        );
      }
    });
  });

  // --- Segmentation --------------------------------------------------------------------------

  const proxyIds = new Set(doc.collisionProxies.map((p) => p.id));

  doc.segmentation.forEach((profile, profileIndex) => {
    const seen = new Map<string, string>();
    const segmentIds = new Set<string>();

    profile.segments.forEach((segment, segmentIndex) => {
      const path = `segmentation[${profileIndex}].segments[${segmentIndex}]`;

      if (segmentIds.has(segment.id)) {
        error(`${path}.id`, `Profile '${profile.id}' has two segments named '${segment.id}'.`);
      }
      segmentIds.add(segment.id);

      for (const boneId of segment.bones) {
        if (!boneIds.has(boneId)) {
          error(
            `${path}.bones`,
            `Segment '${segment.id}' owns bone '${boneId}', which does not exist.`,
          );
          continue;
        }
        const owner = seen.get(boneId);
        if (owner !== undefined) {
          error(
            `${path}.bones`,
            `Bone '${boneId}' is owned by both '${owner}' and '${segment.id}' in profile ` +
              `'${profile.id}'. Every bone belongs to exactly one segment (ADR-001).`,
          );
        }
        seen.set(boneId, segment.id);
      }

      for (const proxyId of segment.proxies ?? []) {
        if (!proxyIds.has(proxyId)) {
          error(
            `${path}.proxies`,
            `Segment '${segment.id}' references collision proxy '${proxyId}', which does not exist.`,
          );
        }
      }
    });

    // Anatomy must be complete at every fidelity level. This is the check that enforces ADR-001.
    const missing = [...boneIds].filter((id) => !seen.has(id));
    if (missing.length > 0) {
      const shown = missing.slice(0, 8).join(', ');
      const suffix = missing.length > 8 ? `, and ${missing.length - 8} more` : '';
      error(
        `segmentation[${profileIndex}]`,
        `Profile '${profile.id}' does not assign ${missing.length} bone(s) to any segment: ` +
          `${shown}${suffix}. The anatomical layer is always complete -- a bone not promoted to a ` +
          'rigid body must still ride along as a follower of some segment.',
      );
    }

    for (const jointId of profile.joints ?? []) {
      if (!jointIds.has(jointId)) {
        error(
          `segmentation[${profileIndex}].joints`,
          `Profile '${profile.id}' activates joint '${jointId}', which does not exist.`,
        );
      }
    }
  });

  // --- Constraints ---------------------------------------------------------------------------

  const jointsById = new Map(doc.joints.map((j) => [j.id, j]));
  doc.constraints.forEach((constraint, index) => {
    if (constraint.kind.type !== 'jointCoupling') return;
    const refs = [constraint.kind.dependent, ...constraint.kind.drivers.map((d) => d.dof)];
    for (const ref of refs) {
      const joint = jointsById.get(ref.joint);
      if (!joint) {
        error(
          `constraints[${index}]`,
          `Constraint '${constraint.id}' references joint '${ref.joint}', which does not exist.`,
        );
        continue;
      }
      if (ref.dof >= joint.dofs.length) {
        error(
          `constraints[${index}]`,
          `Constraint '${constraint.id}' references DoF index ${ref.dof} of joint '${ref.joint}', ` +
            `which has only ${joint.dofs.length} DoF(s). Indices are zero-based.`,
        );
      }
    }
  });

  // --- Attachment sites ----------------------------------------------------------------------

  doc.attachmentSites.forEach((site, index) => {
    if (!boneIds.has(site.bone)) {
      error(
        `attachmentSites[${index}].bone`,
        `Attachment site '${site.id}' is fixed to bone '${site.bone}', which does not exist.`,
      );
    }
  });

  for (const [index, surface] of (doc.wrappingSurfaces ?? []).entries()) {
    if (!boneIds.has(surface.bone)) {
      error(
        `wrappingSurfaces[${index}].bone`,
        `Wrapping surface '${surface.id}' is fixed to bone '${surface.bone}', which does not exist.`,
      );
    }
  }

  // --- Contact rules -------------------------------------------------------------------------

  // Exclusion pairs name segments. A pair naming nothing would be silently ignored by the
  // compiler, which is exactly how a typo turns into an explosion at run time.
  const segmentIds = new Set(doc.segmentation.flatMap((p) => p.segments.map((s) => s.id)));
  for (const [index, pair] of (doc.contactRules.exclude ?? []).entries()) {
    for (const id of pair) {
      if (!segmentIds.has(id)) {
        error(
          `contactRules.exclude[${index}]`,
          `Exclusion pair names segment '${id}', which no profile defines.`,
        );
      }
    }
  }

  const classNames = new Set(Object.keys(doc.contactRules.classes ?? {}));
  for (const [index, assignment] of (doc.contactRules.assign ?? []).entries()) {
    if (!classNames.has(assignment.class)) {
      error(
        `contactRules.assign[${index}]`,
        `Contact assignment names class '${assignment.class}', which is not defined in ` +
          `contactRules.classes. Defined classes: ${[...classNames].join(', ') || '(none)'}.`,
      );
    }
  }
  if (doc.contactRules.defaultClass && !classNames.has(doc.contactRules.defaultClass)) {
    error(
      'contactRules.defaultClass',
      `Default contact class '${doc.contactRules.defaultClass}' is not defined in ` +
        'contactRules.classes.',
    );
  }

  return issues;
}

/** Depth-first search for a cycle in the anatomical parent relation. */
function findCycle(doc: HsdlDocument): string[] | undefined {
  const parentOf = new Map(doc.bones.map((b) => [b.id, b.parent]));
  const state = new Map<string, 'visiting' | 'done'>();

  for (const bone of doc.bones) {
    if (state.get(bone.id) === 'done') continue;

    const path: string[] = [];
    let current: string | null | undefined = bone.id;

    while (current != null) {
      const seen = state.get(current);
      if (seen === 'done') break;
      if (seen === 'visiting') {
        const start = path.indexOf(current);
        return [...path.slice(start), current];
      }
      state.set(current, 'visiting');
      path.push(current);
      current = parentOf.get(current) ?? null;
    }

    for (const id of path) state.set(id, 'done');
  }
  return undefined;
}
