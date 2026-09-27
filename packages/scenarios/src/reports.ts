/**
 * Validation reports -- the `joint-sweep` and `inertia-audit` scenarios of spec section 13.5 --
 * and the grouping the studio's compile report is listed by.
 *
 * Neither report needs a solver. A joint sweep is the passive moment curve evaluated through each
 * DoF's range, which is a closed-form function of the curve the PassiveJointModule would apply.
 * An inertia audit lists each compiled segment's mass, how many bones it owns, the height of its
 * centre of mass at rest and the diagonal of its inertia tensor in the segment's own frame, and
 * compares the whole-body mass with the mass the morphology asked for. It does not compare a
 * segment with a de Leva figure of its own: the segment masses are de Leva's parts by construction
 * (the compiler's `massMapping.ts` shares each part among the segments that own its bones), so
 * what the audit can catch is mass lost or invented in that sharing, not a disagreement with de
 * Leva. Both return rows so the studio can draw them and a test can assert on them.
 */

import type { ResolvedMorphology } from '@bs-humany/anthropometry';
import { type CompiledArticulation, ROOT_NQ, dofPassiveInertia } from '@bs-humany/compiler';
import { passiveMoment } from '@bs-humany/hsdl';
import { defaultPassiveCurve } from '@bs-humany/modules-mechanics';

export interface SweepRow {
  readonly joint: string;
  readonly axis: string;
  readonly dofIndex: number;
  readonly range: readonly [number, number];
  /** Sampled angles and the passive moment at each, N*m. */
  readonly angles: readonly number[];
  readonly moments: readonly number[];
  /** Moment at the two stops. */
  readonly atLower: number;
  readonly atUpper: number;
  readonly defaulted: boolean;
}

export function jointSweep(model: CompiledArticulation, samples = 25): SweepRow[] {
  return model.dofs.map((dof) => {
    const joint = model.joints[dof.joint];
    const curve = dof.passiveStiffness ?? defaultPassiveCurve(dofPassiveInertia(model, dof));
    const [lo, hi] = dof.range;
    const angles: number[] = [];
    const moments: number[] = [];
    for (let i = 0; i < samples; i++) {
      const q = lo + ((hi - lo) * i) / (samples - 1);
      angles.push(q);
      moments.push(passiveMoment(curve, q, dof.range));
    }
    return {
      joint: joint?.id ?? String(dof.joint),
      axis: dof.axisName,
      dofIndex: ROOT_NQ + dof.index,
      range: dof.range,
      angles,
      moments,
      atLower: passiveMoment(curve, lo, dof.range),
      atUpper: passiveMoment(curve, hi, dof.range),
      defaulted: !dof.passiveStiffness,
    };
  });
}

export interface InertiaRow {
  readonly segment: string;
  readonly mass: number;
  /** How many bones the segment owns. */
  readonly bones: number;
  readonly comHeight: number;
  /** Diagonal of the inertia tensor about the CoM, in the segment frame, kg*m^2. */
  readonly diagonal: readonly [number, number, number];
}

export interface InertiaAudit {
  readonly rows: InertiaRow[];
  readonly totalMass: number;
  readonly targetMass: number;
  /** Whole-body centre of mass height at rest, metres. */
  readonly comHeight: number;
}

export function inertiaAudit(
  model: CompiledArticulation,
  morphology: ResolvedMorphology,
): InertiaAudit {
  let total = 0;
  let comY = 0;
  const rows = model.segments.map((s): InertiaRow => {
    total += s.mass;
    const y = s.restWorld.translation.y + s.com.y;
    comY += s.mass * y;
    const I = s.inertia;
    return {
      segment: s.id,
      mass: s.mass,
      bones: s.bones.length,
      comHeight: y,
      diagonal: [I[0] as number, I[4] as number, I[8] as number],
    };
  });
  return { rows, totalMass: total, targetMass: morphology.input.mass, comHeight: comY / total };
}

/** A note as the compile report lists it: the compiler's, the backend's or the muscle paths'. */
export interface ReportNote {
  readonly severity: 'info' | 'warning' | 'error';
  /** What the note is about, as its source names it: `massProperties`, `segmentLength`, ... */
  readonly feature: string;
  /** Who said it, for the list: `compiler`, the backend's name, `muscle path`. */
  readonly from: string;
  readonly message: string;
}

/** Notes of one kind from one source: listed one by one, or as one line with the rest under it. */
export interface ReportNoteGroup {
  readonly from: string;
  readonly feature: string;
  readonly severity: ReportNote['severity'];
  readonly notes: readonly ReportNote[];
}

/**
 * The notes gathered by source, kind and severity, in the order each group first appears.
 *
 * An L3 body compiles with well over a hundred warnings, nearly all of them one sentence said once
 * a vertebra and once a rib -- that a segment takes a share of a de Leva part by the bulk of its
 * bones. Listed flat, the one warning that is about something else is somewhere in the middle of
 * them. Grouped, the report is a line a kind, each saying how many there are, and a note of a kind
 * that occurs fewer than `least` times is a group of its own, listed as it is.
 */
export function groupReportNotes(notes: readonly ReportNote[], least = 3): ReportNoteGroup[] {
  const groups = new Map<string, ReportNote[]>();
  for (const note of notes) {
    const key = `${note.from}\u0000${note.feature}\u0000${note.severity}`;
    const group = groups.get(key);
    if (group) group.push(note);
    else groups.set(key, [note]);
  }
  const out: ReportNoteGroup[] = [];
  for (const group of groups.values()) {
    const first = group[0] as ReportNote;
    const kind = { from: first.from, feature: first.feature, severity: first.severity };
    if (group.length >= least) out.push({ ...kind, notes: group });
    else for (const note of group) out.push({ ...kind, notes: [note] });
  }
  return out;
}
