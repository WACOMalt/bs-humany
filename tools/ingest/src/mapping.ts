/**
 * Z-Anatomy mesh names -> bs-humany bone IDs.
 *
 * The export names bones in English with a side suffix: `Femurr` / `Femurl`, midline bones with
 * none (`Sacrum`), digits by ordinal (`Third_metacarpal_bonel`), phalanges as
 * `Proximal_phalanx_of_second_finger_of_handr`. Regular series are generated, for the same reason
 * the taxonomy generates them: 56 hand-typed phalanx entries is how a transposed digit gets in.
 *
 * Every entry records its source node name(s), so a value can be re-derived when the dataset
 * updates (CONTRIBUTING rule 5, ADR-011).
 */

export interface BoneSource {
  readonly id: string;
  /** FBX node names whose own geometry is fused into this bone. */
  readonly nodes: readonly string[];
  /** Set when the bone is mapped but must not be packed by default, with the open question. */
  readonly excluded?: string;
}

const entries: BoneSource[] = [];
const one = (id: string, ...nodes: string[]) => entries.push({ id, nodes });
const pair = (base: string, node: (side: 'l' | 'r') => string) => {
  one(`${base}_l`, node('l'));
  one(`${base}_r`, node('r'));
};

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'] as const;
const RIB_ORDINAL = [
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Ninth',
  'Tenth',
  'Eleventh',
  'Twelfth',
] as const;

// --- Axial ---------------------------------------------------------------------------------
one('sacrum', 'Sacrum');
one('coccyx', 'Coccyx');
for (let l = 1; l <= 5; l++) one(`vertebra_l${l}`, `Vertebra_L${l}`);
for (let t = 1; t <= 12; t++) one(`vertebra_t${t}`, `Vertebra_T${t}`);
one('vertebra_c1', 'Atlas_(C1)');
one('vertebra_c2', 'Axis_(C2)');
for (let c = 3; c <= 7; c++) one(`vertebra_c${c}`, `Vertebra_C${c}`);
for (let r = 1; r <= 12; r++) pair(`rib_${r}`, (s) => `${RIB_ORDINAL[r - 1]}_rib${s}`);
// Three meshes in the export; one bone in the standard count.
one('sternum', 'Manubrium_of_sternum', 'Body_of_sternum', 'Xiphoid_process');

// --- Skull ---------------------------------------------------------------------------------
one('occipital', 'Occipital_bone');
one('sphenoid', 'Sphenoid_bone');
one('frontal', 'Frontal_bone');
one('ethmoid', 'Ethmoid_bone');
one('vomer', 'Vomer');
one('mandible', 'Mandible');
one('hyoid', 'Hyoid_bone');
pair('parietal', (s) => `Parietal_bone${s}`);
pair('temporal', (s) => `Temporal_bone${s}`);
pair('nasal', (s) => `Nasal_bone${s}`);
pair('lacrimal', (s) => `Lacrimal_bone${s}`);
pair('maxilla', (s) => `Maxilla${s}`);
pair('zygomatic', (s) => `Zygomatic_bone${s}`);
pair('palatine', (s) => `Palatine_bone${s}`);
pair('concha_nasalis_inferior', (s) => `Inferior_nasal_concha_bone${s}`);

// The auditory ossicles are mapped but excluded by default. Z-Anatomy credits "Anatomy of the
// Inner Ear" (University of Dundee, CC-BY-NC-SA 4.0) among its sources, and the ossicles sit in
// the adjacent middle ear. Until their provenance is confirmed they cannot go into CC BY-SA data:
// a non-commercial licence cannot be combined with Share-Alike. See OQ-004.
for (const [base, node] of [
  ['malleus', 'Malleus'],
  ['incus', 'Incus'],
  ['stapes', 'Stapes'],
] as const) {
  for (const s of ['l', 'r'] as const) {
    entries.push({ id: `${base}_${s}`, nodes: [`${node}${s}`], excluded: 'OQ-004' });
  }
}

// --- Upper limb ----------------------------------------------------------------------------
pair('clavicle', (s) => `Clavicle${s}`);
pair('scapula', (s) => `Scapula${s}`);
pair('humerus', (s) => `Humerus${s}`);
pair('ulna', (s) => `Ulna${s}`);
pair('radius', (s) => `Radius${s}`);
for (const carpal of [
  'scaphoid',
  'lunate',
  'triquetrum',
  'pisiform',
  'trapezium',
  'trapezoid',
  'capitate',
  'hamate',
]) {
  const cap = carpal[0]?.toUpperCase() + carpal.slice(1);
  pair(carpal, (s) => `${cap}_bone${s}`);
}
for (let d = 1; d <= 5; d++) {
  const ord = ORDINAL[d - 1] ?? 'first';
  const Ord = ord[0]?.toUpperCase() + ord.slice(1);
  pair(`metacarpal_${d}`, (s) => `${Ord}_metacarpal_bone${s}`);
  const segments =
    d === 1 ? (['proximal', 'distal'] as const) : (['proximal', 'middle', 'distal'] as const);
  for (const seg of segments) {
    const Seg = seg[0]?.toUpperCase() + seg.slice(1);
    pair(`phalanx_${seg}_${d}`, (s) => `${Seg}_phalanx_of_${ord}_finger_of_hand${s}`);
  }
}

// --- Lower limb ----------------------------------------------------------------------------
pair('hip', (s) => `Hip_bone${s}`);
pair('femur', (s) => `Femur${s}`);
pair('patella', (s) => `Patella${s}`);
pair('tibia', (s) => `Tibia${s}`);
pair('fibula', (s) => `Fibula${s}`);
pair('talus', (s) => `Talus${s}`);
pair('calcaneus', (s) => `Calcaneus${s}`);
pair('navicular', (s) => `Navicular_bone${s}`);
pair('cuboid', (s) => `Cuboid_bone${s}`);
pair('cuneiform_medial', (s) => `Medial_cuneiform_bone${s}`);
pair('cuneiform_intermediate', (s) => `Intermediate_cuneiform_bone${s}`);
pair('cuneiform_lateral', (s) => `Lateral_cuneiform_bone${s}`);
for (let d = 1; d <= 5; d++) {
  const ord = ORDINAL[d - 1] ?? 'first';
  const Ord = ord[0]?.toUpperCase() + ord.slice(1);
  pair(`metatarsal_${d}`, (s) => `${Ord}_metatarsal_bone${s}`);
  const segments =
    d === 1 ? (['proximal', 'distal'] as const) : (['proximal', 'middle', 'distal'] as const);
  for (const seg of segments) {
    const Seg = seg[0]?.toUpperCase() + seg.slice(1);
    pair(`phalanx_pedis_${seg}_${d}`, (s) => `${Seg}_phalanx_of_${ord}_finger_of_foot${s}`);
  }
}

export const BONE_SOURCES: readonly BoneSource[] = entries;
