import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation, emitMjcf } from '@bs-humany/compiler';
import { buildDocument } from '@bs-humany/skeleton';
import loadMujoco from '@mujoco/mujoco';
import { describe, expect, it } from 'vitest';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);

describe('MJCF round trip through mj_forward', () => {
  it('loads, has the articulation’s dimensions, and reproduces every segment rest pose', async () => {
    const mujoco = await loadMujoco();
    const { xml } = emitMjcf(articulation, { ground: { height: 0 } });
    const model = mujoco.MjModel.from_xml_string(xml);
    expect(model.nv).toBe(articulation.nv);
    expect(model.nq).toBe(articulation.nq);
    const data = new mujoco.MjData(model);
    mujoco.mj_forward(model, data);
    const objBody = (mujoco as unknown as { mjtObj: { mjOBJ_BODY: { value: number } } }).mjtObj
      .mjOBJ_BODY.value;
    const xpos = data.xpos as Float64Array;
    const xquat = data.xquat as Float64Array;
    for (const segment of articulation.segments) {
      const id = mujoco.mj_name2id(model, objBody, segment.id);
      expect(id, segment.id).toBeGreaterThan(0);
      const t = segment.restWorld;
      expect(xpos[3 * id]).toBeCloseTo(t.translation.x, 6);
      expect(xpos[3 * id + 1]).toBeCloseTo(t.translation.y, 6);
      expect(xpos[3 * id + 2]).toBeCloseTo(t.translation.z, 6);
      // MuJoCo quaternions are w x y z; either sign is the same rotation.
      const dot =
        (xquat[4 * id] ?? 0) * t.rotation.w +
        (xquat[4 * id + 1] ?? 0) * t.rotation.x +
        (xquat[4 * id + 2] ?? 0) * t.rotation.y +
        (xquat[4 * id + 3] ?? 0) * t.rotation.z;
      expect(Math.abs(dot)).toBeCloseTo(1, 6);
    }
    data.delete();
    model.delete();
  });
});
