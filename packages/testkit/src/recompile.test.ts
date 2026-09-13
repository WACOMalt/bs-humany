import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { NULL_SPACE_ONSET, RapierBackend } from '@bs-humany/backend-rapier';
import {
  type IPhysicsBackend,
  ROOT_NQ,
  allocateBuffers,
  compileArticulation,
  forwardKinematics,
  transferJointState,
} from '@bs-humany/compiler';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';

const document = buildDocument();
const at = (stature: number) => resolveMorphology({ sex: 0.5, stature, mass: 70 });
const l1 = compileArticulation(document, 'l1_standard', at(1.7)).articulation;

describe('forward kinematics', () => {
  it('reproduces the rest pose at neutral coordinates', () => {
    const q = new Float64Array(l1.nq);
    const root = l1.segments[l1.root];
    if (!root) throw new Error('no root');
    q.set([
      root.restWorld.translation.x,
      root.restWorld.translation.y,
      root.restWorld.translation.z,
    ]);
    q.set(
      [
        root.restWorld.rotation.x,
        root.restWorld.rotation.y,
        root.restWorld.rotation.z,
        root.restWorld.rotation.w,
      ],
      3,
    );
    const n = l1.segments.length;
    const out = { position: new Float64Array(3 * n), orientation: new Float64Array(4 * n) };
    forwardKinematics(l1, q, undefined, out);
    for (const s of l1.segments) {
      expect(out.position[3 * s.index]).toBeCloseTo(s.restWorld.translation.x, 9);
      expect(out.position[3 * s.index + 1]).toBeCloseTo(s.restWorld.translation.y, 9);
      expect(out.position[3 * s.index + 2]).toBeCloseTo(s.restWorld.translation.z, 9);
    }
  });
});

/**
 * Segments at or below a three-hinge joint whose first and third axes coincide at neutral (an
 * Euler-like sequence) and whose middle angle is within the solver's null-space onset: the
 * smallest singular value of such a sequence is `1 - |cos(middle)|`, and inside the onset the
 * Rapier solver regularises the split rather than resolving it (jointSolver.ts).
 */
function segmentsBelowSingularJoints(q: Float64Array): Set<number> {
  const singular = new Set<number>();
  for (const joint of l1.joints) {
    if (joint.dofs.length !== 3) continue;
    const [a, b, c] = joint.dofs;
    if (!a || !b || !c) continue;
    const dot = a.vector.x * c.vector.x + a.vector.y * c.vector.y + a.vector.z * c.vector.z;
    if (Math.abs(Math.abs(dot) - 1) > 1e-9) continue;
    const middle = q[ROOT_NQ + b.index] ?? 0;
    if (1 - Math.abs(Math.cos(middle)) < NULL_SPACE_ONSET) singular.add(joint.childSegment);
  }
  const below = new Set<number>();
  for (const segment of l1.segments) {
    for (let cursor = segment.index; cursor >= 0; cursor = l1.segments[cursor]?.parent ?? -1) {
      if (singular.has(cursor)) {
        below.add(segment.index);
        break;
      }
    }
  }
  return below;
}

async function stepped(backend: IPhysicsBackend, ticks: number) {
  await backend.init({ dt: 1 / 500, iterations: 8, ground: { height: 0 } });
  await backend.compile(l1);
  const buffers = allocateBuffers(l1);
  for (let i = 0; i < ticks; i++) backend.step(1);
  backend.readJointState(buffers.jointState);
  backend.readPose(buffers.pose);
  return { backend, buffers };
}

describe.each([
  ['rapier', () => new RapierBackend()],
  ['mujoco', () => new MujocoBackend()],
] as const)('recompile-and-restore on %s', (_name, make) => {
  it('places a fresh backend at a running one’s state, losslessly in joint space', async () => {
    const running = await stepped(make(), 150);
    const fresh = make();
    await fresh.init({ dt: 1 / 500, iterations: 8, ground: { height: 0 } });
    await fresh.compile(l1);
    const started = performance.now();
    fresh.writeJointState(running.buffers.jointState.q, running.buffers.jointState.qdot);
    const restoreMs = performance.now() - started;
    const buffers = allocateBuffers(l1);
    fresh.readJointState(buffers.jointState);
    fresh.readPose(buffers.pose);
    // MuJoCo's coordinates are the state itself. Rapier recovers them from body poses; away from
    // a singular sequence the recovery is exact, and along the near-null direction of one (the
    // Y-X-Y shoulder hanging at rest) it is regularised toward neutral, which moves the split
    // by a fraction of a milliradian (jointSolver.ts, NULL_SPACE_ONSET).
    const qTolerance = _name === 'rapier' ? 1e-3 : 1e-9;
    for (let i = 0; i < l1.nq; i++) {
      const diff = Math.abs(
        (buffers.jointState.q[i] ?? 0) - (running.buffers.jointState.q[i] ?? 0),
      );
      expect(diff, `q[${i}]`).toBeLessThan(qTolerance);
    }
    // Body positions match to the running backend's own joint drift, which on Rapier is a
    // millimetre or two (spec 9.4) and on MuJoCo nothing -- except below a regularised joint,
    // where the angles deliberately do not encode the swing the sequence cannot represent, so
    // the pose rebuilt from them differs by that swing (centimetres at the hand).
    const tolerance = _name === 'rapier' ? 0.005 : 1e-6;
    const regularised = _name === 'rapier' ? 0.05 : 1e-6;
    const nearNull = segmentsBelowSingularJoints(running.buffers.jointState.q);
    for (const segment of l1.segments) {
      for (let k = 0; k < 3; k++) {
        const i = 3 * segment.index + k;
        const diff = Math.abs(
          (buffers.pose.position[i] ?? 0) - (running.buffers.pose.position[i] ?? 0),
        );
        expect(diff, `position[${i}] (${segment.id})`).toBeLessThan(
          nearNull.has(segment.index) ? regularised : tolerance,
        );
      }
    }
    expect(restoreMs).toBeLessThan(50);
    running.backend.dispose();
    fresh.dispose();
  });

  it('carries the state to the same profile compiled at a new stature', async () => {
    const running = await stepped(make(), 150);
    const taller = compileArticulation(document, 'l1_standard', at(1.85)).articulation;
    const { q, qdot, unmatched } = transferJointState(
      { model: l1, q: running.buffers.jointState.q, qdot: running.buffers.jointState.qdot },
      taller,
    );
    expect(unmatched).toEqual([]);
    const fresh = make();
    await fresh.init({ dt: 1 / 500, iterations: 8, ground: { height: 0 } });
    await fresh.compile(taller);
    fresh.writeJointState(q, qdot);
    const buffers = allocateBuffers(taller);
    fresh.readJointState(buffers.jointState);
    for (let i = ROOT_NQ; i < taller.nq; i++) {
      const diff = Math.abs(
        (buffers.jointState.q[i] ?? 0) - (running.buffers.jointState.q[i] ?? 0),
      );
      expect(diff, `q[${i}]`).toBeLessThan(_name === 'rapier' ? 1e-3 : 1e-9);
    }
    // The taller body keeps simulating from there without a jolt.
    for (let i = 0; i < 100; i++) fresh.step(1);
    fresh.readPose(buffers.pose);
    for (let i = 0; i < buffers.pose.position.length; i++)
      expect(Number.isFinite(buffers.pose.position[i])).toBe(true);
    running.backend.dispose();
    fresh.dispose();
  });
});
