import { isSourced, validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { FALSE_RIBS, TRUE_RIBS, buildConstraints } from './constraints.js';
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
    // Every coupling is transcribed from MyoSuite; the costal welds are provisional against
    // OQ-011, because no stiffness for the cartilage they stand in for has been cited yet.
    for (const c of document.constraints) {
      if (c.kind.type === 'weld') {
        expect(isSourced(c.source ?? { key: '' }), c.id).toBe(false);
        expect(c.source?.provisional?.openQuestion, c.id).toBe('OQ-011');
        continue;
      }
      expect(c.source && isSourced(c.source), c.id).toBe(true);
      expect(c.source?.key).toBe('caggiano2022');
    }
  });

  it('close the rib cage, which a tree of joints cannot', () => {
    const welds = document.constraints.filter((c) => c.kind.type === 'weld');
    // Both sides of ribs 1 to 7 to the sternum, less the first right rib, which carries the
    // sternum already; plus both sides of ribs 8 to 10 to the rib above, which is the costal
    // margin. The eleventh and twelfth float, in life and here.
    expect(welds).toHaveLength(2 * TRUE_RIBS - 1 + 2 * (FALSE_RIBS - TRUE_RIBS));
    expect(welds.map((c) => c.id)).toContain('sternocostal_7_l');
    expect(welds.map((c) => c.id)).not.toContain('sternocostal_1_r');
    expect(welds.map((c) => c.id)).toContain('interchondral_8_r');
    expect(welds.map((c) => c.id)).not.toContain('interchondral_11_r');
    for (const c of welds) {
      if (c.kind.type !== 'weld') throw new Error(c.id);
      const bodies = [c.kind.bodyA, c.kind.bodyB];
      if (c.id.startsWith('interchondral_')) {
        // Rib to the rib above, never to the sternum: that is the joint the costal margin is.
        expect(
          bodies.every((b) => b.startsWith('rib_')),
          c.id,
        ).toBe(true);
        continue;
      }
      expect(bodies).toContain('sternum');
    }
  });

  it('hold the costal margin compliantly and the sternum rigidly', () => {
    for (const c of document.constraints.filter((x) => x.kind.type === 'weld')) {
      // A rib that hangs from its own vertebra and is also tied to the rib above closes a loop a
      // moving spine pulls on. Rigid, that loop never settles; compliant, it does.
      expect(c.soft, c.id).toBe(c.id.startsWith('interchondral_'));
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
