import { resolveMorphology } from '@bs-humany/anthropometry';
import { allocateBuffers, compileArticulation } from '@bs-humany/compiler';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { MujocoBackend } from './mujocoBackend.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });

describe('every committed profile on MuJoCo', () => {
  it.each(document.segmentation.map((p) => p.id))(
    '%s compiles and steps a short drop',
    async (profileId) => {
      const { articulation } = compileArticulation(document, profileId, morphology);
      const backend = new MujocoBackend();
      await backend.init({ dt: 1 / 1000, iterations: 8, ground: { height: 0 } });
      const report = await backend.compile(articulation);
      expect(report.segments).toBe(articulation.segments.length);
      const buffers = allocateBuffers(articulation);
      for (let i = 0; i < 300; i++) backend.step(1);
      backend.readPose(buffers.pose);
      for (let i = 0; i < buffers.pose.position.length; i++) {
        expect(Number.isFinite(buffers.pose.position[i])).toBe(true);
      }
      backend.dispose();
    },
  );
});
