/**
 * MJCF emitter -- milestone M3.14.
 *
 * ADR-002 made HSDL an MJCF superset so that this step is close to mechanical, and it is: a
 * `CompiledArticulation` already has one hinge per DoF, per-DoF range, damping, armature and
 * friction loss, body-frame inertia, primitive geoms and contact exclusions. What MJCF lacks is
 * named in the emitter's notes rather than dropped silently (spec section 9.3): the
 * double-exponential passive curve has no MJCF equivalent and stays with the PassiveJointModule.
 *
 * Conventions:
 *   - `<compiler angle="radian">`; lengths in metres; the world frame is the canonical one.
 *   - Body names are segment ids, joint names are `<joint id>/<axis>`, geom names proxy ids.
 *   - A child body's frame is the joint frame at neutral: `frameInParent` places it in the
 *     parent, and `frameInChild` inverted places the child segment's own frame within it, so the
 *     nested `<body>` for the segment sits under a joint-frame body. Joint axes are then the DoF
 *     vectors as given, and the MuJoCo joint sequence R(a1,q1) R(a2,q2) R(a3,q3) matches the
 *     articulation's definition exactly.
 *   - Capsules are along local Y in HSDL and local Z in MJCF; the emitter rotates them.
 */

import {
  type Quat,
  type Transform,
  compose,
  fromAxisAngle,
  invert,
  multiplyQuat,
} from '@bs-humany/frames';
import type {
  CompiledArticulation,
  CompiledJoint,
  CompiledProxy,
  CompiledSegment,
} from './articulation.js';
import type { CompileNote, StaticBox } from './backend.js';

export interface MjcfOptions {
  /** Ground plane height; omit for none. */
  readonly ground?:
    | { readonly height: number; readonly contactClass?: string | undefined }
    | undefined;
  readonly timestep?: number | undefined;
  /** Model name attribute. */
  readonly name?: string | undefined;
  /**
   * Where per-DoF damping, armature, friction loss and linear stiffness are applied. `module`
   * (default) leaves them out so the PassiveJointModule supplies them identically on every
   * backend (spec section 7.3); `native` writes them into the joints for standalone MJCF use.
   */
  readonly passive?: 'module' | 'native' | undefined;
  readonly staticBoxes?: readonly StaticBox[] | undefined;
}

export interface MjcfResult {
  readonly xml: string;
  readonly notes: readonly CompileNote[];
  /** Joint names in DoF order, matching `articulation.dofs`. */
  readonly jointNames: readonly string[];
  /** Body names in segment order. */
  readonly bodyNames: readonly string[];
}

const f = (x: number) => (Object.is(x, -0) ? '0' : Number(x.toPrecision(10)).toString());
const v3 = (x: number, y: number, z: number) => `${f(x)} ${f(y)} ${f(z)}`;
/** MJCF quaternions are w x y z. */
const q4 = (q: Quat) => `${f(q.w)} ${f(q.x)} ${f(q.y)} ${f(q.z)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** HSDL capsules run along local Y; MJCF capsules along local Z. */
const Y_TO_Z: Quat = fromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);

export function emitMjcf(model: CompiledArticulation, options: MjcfOptions = {}): MjcfResult {
  const notes: CompileNote[] = [];
  const jointNames: string[] = new Array<string>(model.dofs.length).fill('');
  const bodyNames = model.segments.map((s) => s.id);
  const children = new Map<number, CompiledJoint[]>();
  for (const joint of model.joints) {
    children.set(joint.parentSegment, [...(children.get(joint.parentSegment) ?? []), joint]);
  }
  const proxiesOf = (segment: CompiledSegment) =>
    segment.proxyIndices.map((i) => model.proxies[i]).filter((p): p is CompiledProxy => !!p);

  if (options.passive !== 'native') {
    notes.push({
      severity: 'info',
      feature: 'passiveStiffness',
      message:
        'Per-DoF passive terms are left to the PassiveJointModule so both backends apply the ' +
        'same model; the emitted joints carry ranges only.',
    });
  } else if (model.dofs.some((d) => d.passiveStiffness)) {
    notes.push({
      severity: 'warning',
      feature: 'passiveStiffness',
      message:
        'The double-exponential passive curve has no MJCF equivalent; only linear damping, ' +
        'armature and friction loss are emitted natively.',
    });
  }
  for (const c of model.constraints) {
    if (c.kind.type === 'weld') {
      notes.push({
        severity: 'warning',
        feature: 'constraint',
        element: c.id,
        message: `Weld '${c.id}' is not emitted yet.`,
      });
    }
  }

  const lines: string[] = [];
  const push = (depth: number, text: string) => lines.push(`${'  '.repeat(depth)}${text}`);

  push(0, `<mujoco model="${esc(options.name ?? `${model.documentId}:${model.profileId}`)}">`);
  push(1, '<compiler angle="radian" coordinate="local" inertiafromgeom="false"/>');
  push(
    1,
    `<option timestep="${f(options.timestep ?? 0.002)}" gravity="${v3(model.gravity.x, model.gravity.y, model.gravity.z)}"/>`,
  );

  // Contact classes as geom defaults.
  // Limits and contacts stiffer than MuJoCo's defaults: a 10 ms time constant instead of 20,
  // so a body's weight against ground friction bends a stop by a few degrees, not twenty.
  push(1, '<default>');
  push(2, '<joint solreflimit="0.01 1" solimplimit="0.95 0.99 0.001 0.5 2"/>');
  push(2, '<geom condim="3" solref="0.01 1" solimp="0.95 0.99 0.001 0.5 2"/>');
  for (const [name, cls] of Object.entries(model.contactClasses)) {
    push(2, `<default class="${esc(name)}">`);
    push(3, `<geom friction="${f(cls.friction)} 0.005 0.0001"/>`);
    push(2, '</default>');
  }
  push(1, '</default>');

  // Convex hulls are mesh assets; MuJoCo takes the convex hull of the vertices itself.
  const hulls = model.proxies.filter((p) => p.shape.kind === 'convexHull');
  if (hulls.length > 0) {
    push(1, '<asset>');
    for (const proxy of hulls) {
      if (proxy.shape.kind !== 'convexHull') continue;
      const vertex = proxy.shape.vertices.map((v) => v3(v.x, v.y, v.z)).join(' ');
      push(2, `<mesh name="${esc(proxy.id)}" vertex="${vertex}"/>`);
    }
    push(1, '</asset>');
  }

  push(1, '<worldbody>');
  if (options.ground) {
    // A plane collides from its local +Z side; rotating Z onto world +Y makes it a floor.
    const cls = options.ground.contactClass ?? model.proxies[0]?.contactClass;
    push(
      2,
      `<geom name="ground" type="plane" size="20 20 0.1" pos="0 ${f(options.ground.height)} 0" ` +
        `quat="${q4(fromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2))}"${cls ? ` class="${esc(cls)}"` : ''}/>`,
    );
  }

  for (const box of options.staticBoxes ?? []) {
    const cls = box.contactClass ?? model.proxies[0]?.contactClass;
    const rot = box.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
    push(
      2,
      `<geom name="${esc(box.id)}" type="box" size="${v3(box.halfExtents.x, box.halfExtents.y, box.halfExtents.z)}" ` +
        `pos="${v3(box.position.x, box.position.y, box.position.z)}" quat="${q4(rot)}"${cls ? ` class="${esc(cls)}"` : ''}/>`,
    );
  }

  const emitGeoms = (segment: CompiledSegment, depth: number) => {
    for (const proxy of proxiesOf(segment)) {
      const t = proxy.transform;
      const s = proxy.shape;
      const cls = ` class="${esc(proxy.contactClass)}"`;
      if (s.kind === 'capsule') {
        const rot = multiplyQuat(t.rotation, Y_TO_Z);
        push(
          depth,
          `<geom name="${esc(proxy.id)}" type="capsule" size="${f(s.radius)} ${f(s.length / 2)}" ` +
            `pos="${v3(t.translation.x, t.translation.y, t.translation.z)}" quat="${q4(rot)}"${cls}/>`,
        );
      } else if (s.kind === 'sphere') {
        push(
          depth,
          `<geom name="${esc(proxy.id)}" type="sphere" size="${f(s.radius)}" ` +
            `pos="${v3(t.translation.x, t.translation.y, t.translation.z)}"${cls}/>`,
        );
      } else if (s.kind === 'box') {
        push(
          depth,
          `<geom name="${esc(proxy.id)}" type="box" size="${v3(s.halfExtents.x, s.halfExtents.y, s.halfExtents.z)}" ` +
            `pos="${v3(t.translation.x, t.translation.y, t.translation.z)}" quat="${q4(t.rotation)}"${cls}/>`,
        );
      } else {
        push(
          depth,
          `<geom name="${esc(proxy.id)}" type="mesh" mesh="${esc(proxy.id)}" ` +
            `pos="${v3(t.translation.x, t.translation.y, t.translation.z)}" quat="${q4(t.rotation)}"${cls}/>`,
        );
      }
    }
  };

  const emitInertial = (segment: CompiledSegment, depth: number) => {
    const I = segment.inertia;
    push(
      depth,
      `<inertial pos="${v3(segment.com.x, segment.com.y, segment.com.z)}" mass="${f(segment.mass)}" ` +
        `fullinertia="${f(I[0])} ${f(I[4])} ${f(I[8])} ${f(I[1])} ${f(I[2])} ${f(I[5])}"/>`,
    );
  };

  const emitBody = (segment: CompiledSegment, local: Transform, depth: number) => {
    push(
      depth,
      `<body name="${esc(segment.id)}" pos="${v3(local.translation.x, local.translation.y, local.translation.z)}" quat="${q4(local.rotation)}">`,
    );
    if (segment.index === model.root) push(depth + 1, '<freejoint name="root"/>');
    emitInertial(segment, depth + 1);
    emitGeoms(segment, depth + 1);
    for (const joint of children.get(segment.index) ?? []) {
      const child = model.segments[joint.childSegment];
      if (!child) continue;
      // Joint-frame body in the parent, then the child segment placed by the inverse child frame.
      push(
        depth + 1,
        `<body name="${esc(joint.id)}" pos="${v3(joint.frameInParent.translation.x, joint.frameInParent.translation.y, joint.frameInParent.translation.z)}" quat="${q4(joint.frameInParent.rotation)}">`,
      );
      for (const dof of joint.dofs) {
        const name = `${joint.id}/${dof.axisName}`;
        jointNames[dof.index] = name;
        const attrs = [
          `name="${esc(name)}"`,
          `type="${dof.kind === 'hinge' ? 'hinge' : 'slide'}"`,
          `axis="${v3(dof.vector.x, dof.vector.y, dof.vector.z)}"`,
          `range="${f(dof.range[0])} ${f(dof.range[1])}"`,
          'limited="true"',
          `ref="${f(dof.neutral)}"`,
        ];
        // Armature is conditioning, not a passive force, so it is emitted in either mode.
        if (dof.armature > 0) attrs.push(`armature="${f(dof.armature)}"`);
        if (options.passive === 'native') {
          if (dof.passiveDamping > 0) attrs.push(`damping="${f(dof.passiveDamping)}"`);
          if (dof.frictionLoss > 0) attrs.push(`frictionloss="${f(dof.frictionLoss)}"`);
          if (dof.passiveStiffness?.linear) {
            attrs.push(`stiffness="${f(dof.passiveStiffness.linear)}"`);
            attrs.push(`springref="${f(dof.passiveStiffness.linearNeutral ?? dof.neutral)}"`);
          }
        }
        push(depth + 2, `<joint ${attrs.join(' ')}/>`);
      }
      // A joint-frame body with no mass of its own; MuJoCo needs the flag or an inertial.
      push(depth + 2, '<inertial pos="0 0 0" mass="0.001" diaginertia="1e-7 1e-7 1e-7"/>');
      emitBody(child, invert(joint.frameInChild), depth + 2);
      push(depth + 1, '</body>');
    }
    push(depth, '</body>');
  };

  const root = model.segments[model.root];
  if (!root) throw new Error('Articulation has no root segment.');
  emitBody(root, root.restWorld, 2);
  push(1, '</worldbody>');

  if (model.excludedPairs.length > 0) {
    push(1, '<contact>');
    for (const [a, b] of model.excludedPairs) {
      const sa = model.segments[a];
      const sb = model.segments[b];
      if (sa && sb) push(2, `<exclude body1="${esc(sa.id)}" body2="${esc(sb.id)}"/>`);
    }
    push(1, '</contact>');
  }

  const couplings = model.constraints.filter((c) => c.kind.type === 'jointCoupling');
  if (couplings.length > 0) {
    push(1, '<equality>');
    for (const c of couplings) {
      if (c.kind.type !== 'jointCoupling') continue;
      const dependent = jointNames[c.kind.dependent];
      const driver = c.kind.drivers[0];
      if (c.kind.drivers.length !== 1 || !driver || !dependent) {
        notes.push({
          severity: 'warning',
          feature: 'constraint',
          element: c.id,
          message: `Coupling '${c.id}' has ${c.kind.drivers.length} drivers; MJCF joint equality couples one pair.`,
        });
        continue;
      }
      const driven = jointNames[driver.dof];
      const [c2, c3, c4] = driver.higher ?? [0, 0, 0];
      push(
        2,
        `<joint name="${esc(c.id)}" joint1="${esc(dependent)}" joint2="${esc(driven ?? '')}" ` +
          `polycoef="${f(c.kind.offset)} ${f(driver.coefficient)} ${f(c2)} ${f(c3)} ${f(c4)}"` +
          `${c.soft ? '' : ' solimp="0.9999 0.9999 0.001 0.5 2"'}/>`,
      );
    }
    push(1, '</equality>');
  }

  push(0, '</mujoco>');
  return { xml: `${lines.join('\n')}\n`, notes, jointNames, bodyNames };
}

/** World transform of a child segment implied by the emitted nesting; for tests and validation. */
export function childRestFromMjcf(parentWorld: Transform, joint: CompiledJoint): Transform {
  return compose(compose(parentWorld, joint.frameInParent), invert(joint.frameInChild));
}
