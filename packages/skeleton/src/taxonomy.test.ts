import { describe, expect, it } from 'vitest';
import { divisionOf } from './taxonomy-types.js';
import {
  BONES,
  EXPECTED_BONE_COUNT,
  ROOT_BONE_ID,
  ancestorsOf,
  boneIds,
  bonesInRegion,
  childrenOf,
  getBone,
} from './taxonomy.js';

describe('the count', () => {
  it('is 206', () => {
    expect(BONES.length).toBe(EXPECTED_BONE_COUNT);
  });

  it('splits 80 axial and 126 appendicular', () => {
    const axial = BONES.filter((b) => divisionOf(b.region) === 'axial');
    const appendicular = BONES.filter((b) => divisionOf(b.region) === 'appendicular');
    expect(axial.length).toBe(80);
    expect(appendicular.length).toBe(126);
  });

  it('has the expected regional counts', () => {
    // Spelled out so a miscount surfaces as "the hand has 26 bones" rather than as a total that
    // happens to come to 206 by two errors cancelling.
    const counts = {
      skull: 29, // 22 skull + 6 ossicles + hyoid, all grouped under the skull region here
      cervical: 7,
      thoracic: 12,
      lumbar: 5,
      sacral: 2, // sacrum + coccyx
      thorax: 25, // 24 ribs + sternum
      shoulder_girdle: 4,
      arm: 2,
      forearm: 4,
      hand: 54,
      pelvis: 2,
      thigh: 4, // femur + patella, both sides
      leg: 4,
      foot: 52,
    } as const;

    for (const [region, expected] of Object.entries(counts)) {
      expect(bonesInRegion(region as keyof typeof counts).length, `region ${region}`).toBe(
        expected,
      );
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(EXPECTED_BONE_COUNT);
  });

  it('has 27 bones per hand and 26 per foot', () => {
    // The classic counts. 8 carpals + 5 metacarpals + 14 phalanges = 27.
    // 7 tarsals + 5 metatarsals + 14 phalanges = 26.
    for (const side of ['l', 'r'] as const) {
      expect(BONES.filter((b) => b.region === 'hand' && b.id.endsWith(`_${side}`)).length).toBe(27);
      expect(BONES.filter((b) => b.region === 'foot' && b.id.endsWith(`_${side}`)).length).toBe(26);
    }
  });
});

describe('identifiers', () => {
  it('are unique', () => {
    const ids = boneIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('are lowercase snake_case ASCII', () => {
    // Spec section 4.4. These are the ABI, so the shape is part of the contract.
    for (const b of BONES) {
      expect(b.id, b.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('use _l and _r suffixes for paired bones, and no suffix for unpaired ones', () => {
    for (const b of BONES) {
      if (b.side === undefined) {
        expect(b.id.endsWith('_l') || b.id.endsWith('_r'), `${b.id} is unpaired`).toBe(false);
      } else {
        expect(b.id.endsWith(b.side === 'left' ? '_l' : '_r'), b.id).toBe(true);
      }
    }
  });

  it('pair every sided bone with its mirror', () => {
    const sided = BONES.filter((b) => b.side !== undefined);
    expect(sided.length % 2).toBe(0);
    for (const b of sided) {
      const mirrorId = b.id.endsWith('_l') ? `${b.id.slice(0, -2)}_r` : `${b.id.slice(0, -2)}_l`;
      const mirror = getBone(mirrorId);
      expect(mirror, `${b.id} has no mirror ${mirrorId}`).toBeDefined();
      expect(mirror?.ta).toBe(b.ta);
      expect(mirror?.region).toBe(b.region);
    }
  });

  it('give every bone a Terminologia Anatomica term and a display name', () => {
    for (const b of BONES) {
      expect(b.ta.length, b.id).toBeGreaterThan(0);
      expect(b.displayName.length, b.id).toBeGreaterThan(0);
      // TA terms are Latin and capitalised; a lowercase one is usually a copy-paste of the
      // English name.
      expect(b.ta[0], `${b.id} TA term '${b.ta}'`).toBe(b.ta[0]?.toUpperCase());
    }
  });
});

describe('the hierarchy', () => {
  it('has exactly one root, the sacrum', () => {
    const roots = BONES.filter((b) => b.parent === null);
    expect(roots.map((b) => b.id)).toEqual([ROOT_BONE_ID]);
  });

  it('names a parent that exists, for every non-root bone', () => {
    for (const b of BONES) {
      if (b.parent === null) continue;
      expect(getBone(b.parent), `${b.id} -> ${b.parent}`).toBeDefined();
    }
  });

  it('is acyclic: every bone reaches the root', () => {
    for (const b of BONES) {
      const chain = ancestorsOf(b.id);
      expect(chain.length, b.id).toBeGreaterThan(0);
      expect(chain[chain.length - 1]?.id, `${b.id} does not reach the root`).toBe(ROOT_BONE_ID);
      // A cycle would make the walk revisit a bone.
      expect(new Set(chain.map((c) => c.id)).size, `${b.id} chain repeats`).toBe(chain.length);
    }
  });

  it('keeps paired bones on their own side of the tree', () => {
    // A right-side bone whose ancestry crosses to the left is a transposed suffix, which is the
    // single likeliest data-entry error across 206 entries.
    for (const b of BONES) {
      if (b.side === undefined || b.parentNote !== undefined) continue;
      const parent = b.parent === null ? undefined : getBone(b.parent);
      if (parent?.side === undefined) continue;
      expect(parent.side, `${b.id} (${b.side}) is parented to ${parent.id} (${parent.side})`).toBe(
        b.side,
      );
    }
  });

  it('records a note wherever a parent link is a convention rather than a fact', () => {
    // Unpaired bones articulating bilaterally cannot have a single true parent. The note is what
    // stops a future contributor "fixing" it.
    const conventional = BONES.filter((b) => b.parentNote !== undefined);
    expect(conventional.map((b) => b.id).sort()).toEqual(['hyoid', 'mandible', 'sternum']);
  });
});

describe('anatomically significant relationships', () => {
  it('connects the upper limb to the axial skeleton only through the clavicle', () => {
    // The sternoclavicular joint is the only bony connection. Everything else is muscular, which
    // is why the scapula glides on the thorax rather than articulating with it.
    expect(getBone('clavicle_r')?.parent).toBe('sternum');
    expect(getBone('scapula_r')?.parent).toBe('clavicle_r');
    expect(getBone('humerus_r')?.parent).toBe('scapula_r');
  });

  it('parents the radius to the ulna, since pronation rotates it about the ulna', () => {
    expect(getBone('radius_l')?.parent).toBe('ulna_l');
    expect(getBone('ulna_l')?.parent).toBe('humerus_l');
  });

  it('parents the fibula to the tibia, since it takes almost no load from the knee', () => {
    expect(getBone('fibula_r')?.parent).toBe('tibia_r');
  });

  it('attaches the skull to the column at the atlanto-occipital joint', () => {
    expect(getBone('occipital')?.parent).toBe('vertebra_c1');
  });

  it('names the atlas and axis properly', () => {
    // Spec section 7.2: C1-C2 is rotation-dominant and must not be modelled as a generic 3-DoF
    // ball joint. Naming them distinctly is the first step in not forgetting that.
    expect(getBone('vertebra_c1')?.ta).toBe('Atlas');
    expect(getBone('vertebra_c2')?.ta).toBe('Axis');
  });

  it('runs the vertebral column as a single chain from sacrum to atlas', () => {
    const chain = ancestorsOf('vertebra_c1').map((b) => b.id);
    expect(chain[0]).toBe('vertebra_c1');
    expect(chain).toContain('vertebra_c7');
    expect(chain).toContain('vertebra_t1');
    expect(chain).toContain('vertebra_t12');
    expect(chain).toContain('vertebra_l1');
    expect(chain).toContain('vertebra_l5');
    expect(chain).toContain('sacrum');
    // 7 cervical + 12 thoracic + 5 lumbar + sacrum.
    expect(chain.length).toBe(25);
  });

  it('attaches each rib to its own thoracic vertebra', () => {
    for (let i = 1; i <= 12; i++) {
      expect(getBone(`rib_${i}_l`)?.parent).toBe(`vertebra_t${i}`);
      expect(getBone(`rib_${i}_r`)?.parent).toBe(`vertebra_t${i}`);
    }
  });

  it('gives the thumb and hallux two phalanges and the other digits three', () => {
    expect(getBone('phalanx_middle_1_l')).toBeUndefined();
    expect(getBone('phalanx_proximal_1_l')).toBeDefined();
    expect(getBone('phalanx_distal_1_l')?.parent).toBe('phalanx_proximal_1_l');

    expect(getBone('phalanx_pedis_middle_1_r')).toBeUndefined();
    expect(getBone('phalanx_pedis_distal_1_r')?.parent).toBe('phalanx_pedis_proximal_1_r');

    for (const digit of [2, 3, 4, 5]) {
      expect(getBone(`phalanx_middle_${digit}_l`)?.parent).toBe(`phalanx_proximal_${digit}_l`);
      expect(getBone(`phalanx_distal_${digit}_l`)?.parent).toBe(`phalanx_middle_${digit}_l`);
    }
  });

  it('chains each digit from its metacarpal outward', () => {
    expect(getBone('phalanx_proximal_3_r')?.parent).toBe('metacarpal_3_r');
    expect(getBone('metacarpal_3_r')?.parent).toBe('capitate_r');
  });

  it('gives the patella the femur as parent, not the tibia', () => {
    // The patella is a sesamoid in the quadriceps tendon, tracking in the femoral groove.
    expect(getBone('patella_l')?.parent).toBe('femur_l');
  });

  it('chains the auditory ossicles malleus to incus to stapes', () => {
    expect(getBone('malleus_l')?.parent).toBe('temporal_l');
    expect(getBone('incus_l')?.parent).toBe('malleus_l');
    expect(getBone('stapes_l')?.parent).toBe('incus_l');
  });
});

describe('traversal helpers', () => {
  it('finds children', () => {
    const sacralChildren = childrenOf('sacrum')
      .map((b) => b.id)
      .sort();
    expect(sacralChildren).toEqual(['coccyx', 'hip_l', 'hip_r', 'vertebra_l5']);
  });

  it('returns an empty list for a leaf', () => {
    expect(childrenOf('phalanx_distal_3_l')).toEqual([]);
  });

  it('returns undefined for an unknown id', () => {
    expect(getBone('femur')).toBeUndefined();
    expect(getBone('tibia_x')).toBeUndefined();
  });

  it('reaches every bone from the root', () => {
    // Equivalent to the acyclicity check from the other direction: nothing is orphaned.
    const reached = new Set<string>();
    const walk = (id: string) => {
      reached.add(id);
      for (const child of childrenOf(id)) walk(child.id);
    };
    walk(ROOT_BONE_ID);
    expect(reached.size).toBe(EXPECTED_BONE_COUNT);
  });
});
