import { isSourced, validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { buildConstraints } from './constraints.js';
import { buildDocument } from './document.js';

describe('joint couplings', () => {
  const document = buildDocument();

  it('validate against the joints they reference', () => {
    const result = validateDocument(document);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(document.constraints.length).toBe(buildConstraints().length);
  });

  it('cover the lumbar levels, both patellae and both shoulder girdles, each cited', () => {
    const ids = document.constraints.map((c) => c.id);
    expect(ids).toContain('l3_l4_fe_follows_l4_l5');
    expect(ids).toContain('l1_l2_ar_follows_l4_l5');
    expect(ids).toContain('patellofemoral_r_follows_knee');
    expect(ids).toContain('patellofemoral_l_follows_knee');
    expect(ids).toContain('sternoclavicular_l_dof0_follows_elevation');
    expect(ids).toContain('acromioclavicular_r_dof2_follows_elevation');
    for (const c of document.constraints) {
      expect(c.source && isSourced(c.source), c.id).toBe(true);
      expect(c.source?.key).toBe('caggiano2022');
    }
  });

  it('carry the patella quartic and lumbar ratios as the source states them', () => {
    const patella = document.constraints.find((c) => c.id === 'patellofemoral_r_follows_knee');
    if (patella?.kind.type !== 'jointCoupling') throw new Error('missing');
    expect(patella.kind.offset).toBeCloseTo(0.010506, 9);
    expect(patella.kind.drivers[0]?.higher?.[2]).toBeCloseTo(-0.138302, 9);
    const l1 = document.constraints.find((c) => c.id === 'l1_l2_fe_follows_l4_l5');
    if (l1?.kind.type !== 'jointCoupling') throw new Error('missing');
    expect(l1.kind.drivers[0]?.coefficient).toBeCloseTo(0.255 / 0.185, 9);
  });
});
