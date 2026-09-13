/**
 * Validation reports -- the `joint-sweep` and `inertia-audit` scenarios of spec section 13.5.
 *
 * Neither needs a solver. A joint sweep is the passive moment curve evaluated through each
 * DoF's range, which is a closed-form function of the curve the PassiveJointModule would apply;
 * an inertia audit compares each compiled segment's mass with the de Leva target for the bones
 * it owns. Both return rows so the studio can draw them and a test can assert on them.
 */

import type { ResolvedMorphology } from '@bs-humany/anthropometry';
import { type CompiledArticulation, ROOT_NQ, dofAxisInertia } from '@bs-humany/compiler';
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
    const curve = dof.passiveStiffness ?? defaultPassiveCurve(dofAxisInertia(model, dof));
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
  /** Sum of the de Leva masses the segment drew on, before any split. */
  readonly bones: number;
  readonly comHeight: number;
  readonly principal: readonly [number, number, number];
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
      principal: [I[0] as number, I[4] as number, I[8] as number],
    };
  });
  return { rows, totalMass: total, targetMass: morphology.input.mass, comHeight: comY / total };
}
