/**
 * `CouplingModule` -- the Rapier side of M5.2, spec section 7.4.
 *
 * MuJoCo enforces joint couplings as equality constraints. Rapier has no such thing, so on that
 * backend each coupling is a soft corrective torque: a spring-damper on the coupling error,
 * applied to the dependent DoF and reacted onto the drivers through the coupling's slope, in
 * the `actuate` phase through `actuation.jointTorque`. The Rapier backend reports the couplings
 * as approximated, and this module is the approximation.
 *
 * On a backend that solves couplings natively the module does nothing, so a session can register
 * it unconditionally.
 */

import type { BackendCapabilities, CompiledArticulation } from '@bs-humany/compiler';
import { ROOT_NQ, ROOT_NV, dofAxisInertia } from '@bs-humany/compiler';
import type {
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { ACTUATION_JOINT_TORQUE, BODY_JOINT_STATE, CHANNEL_VERSION } from './channels.js';

export const COUPLING_MODULE_ID = 'bsums.xyz.bs-humany.coupling';

/** Natural frequency of the corrective spring, Hz, for the dependent DoF's own inertia. */
export const COUPLING_FREQUENCY_HZ = 20;

interface Coupling {
  readonly dependent: number;
  readonly drivers: readonly { dof: number; c1: number; c2: number; c3: number; c4: number }[];
  readonly offset: number;
  readonly stiffness: number;
  readonly damping: number;
}

export class CouplingModule implements SimModule {
  readonly manifest: ModuleManifest;
  /** False when the backend solves couplings itself and the module stands down. */
  readonly active: boolean;
  private readonly couplings: Coupling[];
  private q: Float64Array | undefined;
  private qdot: Float64Array | undefined;
  private torque: Float64Array | undefined;

  constructor(
    readonly articulation: CompiledArticulation,
    capabilities: BackendCapabilities,
  ) {
    this.active = capabilities.equalityConstraints !== 'native';
    const omega = 2 * Math.PI * COUPLING_FREQUENCY_HZ;
    this.couplings = articulation.constraints.flatMap((c) => {
      if (c.kind.type !== 'jointCoupling') return [];
      const dof = articulation.dofs[c.kind.dependent];
      const inertia = Math.max(dof ? dofAxisInertia(articulation, dof) : 1e-6, 1e-6);
      const stiffness = inertia * omega * omega;
      return [
        {
          dependent: c.kind.dependent,
          drivers: c.kind.drivers.map((d) => ({
            dof: d.dof,
            c1: d.coefficient,
            c2: d.higher?.[0] ?? 0,
            c3: d.higher?.[1] ?? 0,
            c4: d.higher?.[2] ?? 0,
          })),
          offset: c.kind.offset,
          stiffness,
          damping: 2 * Math.sqrt(stiffness * inertia),
        },
      ];
    });
    this.manifest = {
      id: COUPLING_MODULE_ID,
      version: '1.0.0',
      phase: 'actuate',
      dependsOn: [],
      reads: [{ id: BODY_JOINT_STATE, version: CHANNEL_VERSION }],
      writes: [],
      accumulates: [{ id: ACTUATION_JOINT_TORQUE, version: CHANNEL_VERSION }],
      gives: [],
    };
  }

  /** Coupling errors at the current state, radians, one per compiled coupling. */
  errors(out: Float64Array): void {
    const q = this.q;
    if (!q) return;
    this.couplings.forEach((c, i) => {
      out[i] = (q[ROOT_NQ + c.dependent] as number) - this.target(c, q);
    });
  }

  get count(): number {
    return this.couplings.length;
  }

  private target(c: Coupling, q: Float64Array): number {
    let value = c.offset;
    for (const d of c.drivers) {
      const x = q[ROOT_NQ + d.dof] as number;
      value += d.c1 * x + d.c2 * x * x + d.c3 * x * x * x + d.c4 * x * x * x * x;
    }
    return value;
  }

  init(ctx: ModuleInitContext): void {
    const state = ctx.read(BODY_JOINT_STATE);
    this.q = state.fields.q as Float64Array;
    this.qdot = state.fields.qdot as Float64Array;
    this.torque = ctx.accumulate(ACTUATION_JOINT_TORQUE).fields.torque as Float64Array;
  }

  reset(ctx: ModuleInitContext): void {
    this.init(ctx);
  }

  step(_ctx: ModuleStepContext): void {
    if (!this.active) return;
    const q = this.q;
    const qdot = this.qdot;
    const torque = this.torque;
    if (!q || !qdot || !torque) return;
    for (const c of this.couplings) {
      // Error and its rate: e = q_dep - f(q_drivers), de = qd_dep - sum f'(q_i) qd_i.
      let target = c.offset;
      let targetRate = 0;
      for (const d of c.drivers) {
        const x = q[ROOT_NQ + d.dof] as number;
        const xd = qdot[ROOT_NV + d.dof] as number;
        target += d.c1 * x + d.c2 * x * x + d.c3 * x * x * x + d.c4 * x * x * x * x;
        targetRate += (d.c1 + 2 * d.c2 * x + 3 * d.c3 * x * x + 4 * d.c4 * x * x * x) * xd;
      }
      const error = (q[ROOT_NQ + c.dependent] as number) - target;
      const errorRate = (qdot[ROOT_NV + c.dependent] as number) - targetRate;
      const lambda = -c.stiffness * error - c.damping * errorRate;
      torque[ROOT_NV + c.dependent] = (torque[ROOT_NV + c.dependent] as number) + lambda;
      for (const d of c.drivers) {
        const x = q[ROOT_NQ + d.dof] as number;
        const slope = d.c1 + 2 * d.c2 * x + 3 * d.c3 * x * x + 4 * d.c4 * x * x * x;
        torque[ROOT_NV + d.dof] = (torque[ROOT_NV + d.dof] as number) - lambda * slope;
      }
    }
  }
}
