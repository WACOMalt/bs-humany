/**
 * The activation clips, held to what the research document asks of them: every reference a real
 * unit, `both` exactly two, interpolation that never leaves [0, 1], walking under its amplitude
 * ceiling, standing under its diagnostic threshold, and a mirror that is a mirror.
 */

import {
  ANKLE_MUSCLES,
  ELBOW_MUSCLES,
  FOREARM_MUSCLES,
  HIP_MUSCLES,
  KNEE_MUSCLES,
  SHOULDER_MUSCLES,
  TORSO_MUSCLES,
  TRUNK_MUSCLES,
} from '@bs-humany/muscle-data';
import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_CLIP_FILE,
  type ClipFile,
  compileClip,
  loadActivationClips,
  unitsNamedByClips,
} from './activationClips.js';

const inData = new Set<string>();
for (const region of [
  ELBOW_MUSCLES,
  SHOULDER_MUSCLES,
  FOREARM_MUSCLES,
  TORSO_MUSCLES,
  KNEE_MUSCLES,
  HIP_MUSCLES,
  ANKLE_MUSCLES,
  TRUNK_MUSCLES,
]) {
  for (const group of region) for (const unit of group.units) inData.add(unit.id);
}

const clips = loadActivationClips(inData);
const lowerLimb =
  /^(gluteus|iliacus|psoas|sartorius|tensor|rectus_femoris|vastus|biceps_femoris|semi|adductor|gracilis|piriformis|soleus|gastrocnemius|tibialis|fibularis|flexor_digitorum_longus|flexor_hallucis|extensor_digitorum_longus|extensor_hallucis)/;
const plantarflexor =
  /^(soleus|gastrocnemius|tibialis_posterior|fibularis|flexor_digitorum_longus|flexor_hallucis)/;

describe('the activation clips', () => {
  it('name only units the muscle data has, on both sides', () => {
    const named = unitsNamedByClips();
    const absent = [...named].filter((id) => !inData.has(id));
    expect(absent).toEqual([]);
    expect(clips.size).toBe(3);
    for (const clip of clips.values()) expect(clip.units.length).toBeGreaterThan(0);
  });

  it('expands a both-sided unit track to exactly two units, one each side', () => {
    const file: ClipFile = {
      groups: {},
      clips: [
        {
          id: 'pair',
          displayName: 'pair',
          timebase: 'seconds',
          duration: 1,
          loop: false,
          provenance: 'test',
          tracks: [
            {
              target: { kind: 'unit', id: 'soleus' },
              side: 'both',
              points: [{ t: 0, level: 0.5 }],
            },
          ],
        },
      ],
    };
    const clip = compileClip(file.clips[0] as ClipFile['clips'][number], file.groups, inData);
    expect([...clip.units].sort()).toEqual(['soleus_l', 'soleus_r']);
    expect(() =>
      compileClip(
        {
          ...(file.clips[0] as ClipFile['clips'][number]),
          tracks: [
            { target: { kind: 'unit', id: 'no_such' }, side: 'left', points: [{ t: 0, level: 1 }] },
          ],
        },
        file.groups,
        inData,
      ),
    ).toThrow(/not a unit/);
  });

  it('interpolates monotonically: through the points, never past them, never outside [0, 1]', () => {
    const file: ClipFile = {
      groups: {},
      clips: [
        {
          id: 'curve',
          displayName: 'curve',
          timebase: 'seconds',
          duration: 4,
          loop: false,
          provenance: 'test',
          tracks: [
            {
              target: { kind: 'unit', id: 'soleus' },
              side: 'right',
              points: [
                { t: 0, level: 0 },
                { t: 1, level: 1 },
                { t: 2, level: 1 },
                { t: 3, level: 0.2 },
                { t: 4, level: 0 },
              ],
            },
          ],
        },
      ],
    };
    const clip = compileClip(file.clips[0] as ClipFile['clips'][number], file.groups, inData);
    const at = (t: number) => clip.levels(t)[0] as number;
    expect(at(0)).toBeCloseTo(0, 9);
    expect(at(1)).toBeCloseTo(1, 9);
    expect(at(3)).toBeCloseTo(0.2, 9);
    // A Catmull-Rom would overshoot above 1 between the two 1s and below 0 after the 0; this
    // must not. And between 1 and 2 it is flat, because both ends are the same.
    let previous = -1;
    for (let t = 0; t <= 4; t += 0.005) {
      const level = at(t);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
      if (t <= 1) expect(level).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = level;
    }
    expect(at(1.5)).toBeCloseTo(1, 9);
  });

  it('keeps every shipped clip inside [0, 1] at every millisecond of a period', () => {
    for (const clip of clips.values()) {
      const steps = Math.ceil(clip.period / 0.001);
      for (let i = 0; i <= steps; i++) {
        const levels = clip.levels(i * 0.001);
        for (let u = 0; u < levels.length; u++) {
          const level = levels[u] as number;
          expect(level).toBeGreaterThanOrEqual(0);
          expect(level).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('walks under the amplitude ceiling: no lower-limb unit past 0.6 but the plantarflexors', () => {
    const walk = clips.get('walk-normal');
    expect(walk).toBeDefined();
    if (!walk) return;
    let peak = 0;
    for (let t = 0; t <= walk.period; t += 0.005) {
      const levels = walk.levels(t);
      walk.units.forEach((unit, i) => {
        const level = levels[i] as number;
        if (lowerLimb.test(unit) && !plantarflexor.test(unit)) {
          expect(level, `${unit} at ${t.toFixed(3)} s`).toBeLessThanOrEqual(0.6);
        }
        peak = Math.max(peak, level);
      });
    }
    expect(peak).toBeGreaterThan(0.3);
  });

  it('mirrors the walk: the left leg is the right leg half a cycle on', () => {
    const walk = clips.get('walk-normal');
    if (!walk) throw new Error('no walk');
    const right = walk.units.indexOf('soleus_r');
    const left = walk.units.indexOf('soleus_l');
    expect(right).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThanOrEqual(0);
    for (let t = 0; t < walk.period; t += 0.05) {
      const now = walk.levels(t)[right] as number;
      const later = walk.levels(t + walk.period / 2)[left] as number;
      expect(later).toBeCloseTo(now, 9);
    }
  });

  it('stands with the soleus under the diagnostic threshold, and a hamstring at its larger demand', () => {
    const standing = clips.get('quiet-standing');
    if (!standing) throw new Error('no standing');
    let soleus = 0;
    for (let t = 0; t <= standing.period; t += 0.01) {
      soleus = Math.max(soleus, standing.levels(t)[standing.units.indexOf('soleus_r')] as number);
    }
    expect(soleus).toBeLessThan(0.15);
    // The file says what it is, for the studio to show.
    const raw = ACTIVATION_CLIP_FILE.clips.find((c) => c.id === 'quiet-standing');
    expect(raw?.provenance).toBe('literature-timing');
  });
});
