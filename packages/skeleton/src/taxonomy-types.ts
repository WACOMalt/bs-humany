/**
 * The bone taxonomy: identity and hierarchy only.
 *
 * Deliberately separate from the full `BoneDef`. A taxonomy entry says *what a bone is and where
 * it sits in the body plan*; dimensions, geometry and rest transforms are layered on top by later
 * milestones. Keeping them apart means the naming layer -- which is the project's public ABI and
 * the thing every future module binds to -- can be reviewed, tested and frozen without waiting for
 * geometry to be right.
 *
 * Spec section 4.4: bone IDs MUST NOT change without a major HSDL version bump.
 */

import type { BoneRegion } from '@bs-humany/hsdl';

export interface BoneTaxonomyEntry {
  /** Stable, lowercase snake_case. The ABI. */
  readonly id: string;
  /** Terminologia Anatomica term. The interlingua for anatomical naming. */
  readonly ta: string;
  /** English display name. */
  readonly displayName: string;
  /**
   * Anatomical parent. Exactly one entry has `null`.
   *
   * This is the *containment* tree of the body plan, not the dynamic tree -- which segment
   * articulates against which is decided by the segmentation profile, not here.
   */
  readonly parent: string | null;
  readonly region: BoneRegion;
  readonly side?: 'left' | 'right';
  /**
   * Set where the parent link is a convention rather than a fact, so nobody later "fixes" it.
   *
   * Unpaired bones that articulate bilaterally -- the mandible against both temporal bones, the
   * sternum against both first ribs -- cannot have a single true parent in a tree. The convention
   * is to take the left member and say so here.
   */
  readonly parentNote?: string;
}

/** The three top-level divisions, used for grouping in the UI and in reports. */
export type SkeletalDivision = 'axial' | 'appendicular';

export const AXIAL_REGIONS: ReadonlySet<BoneRegion> = new Set<BoneRegion>([
  'skull',
  'cervical',
  'thoracic',
  'lumbar',
  'sacral',
  'thorax',
]);

export function divisionOf(region: BoneRegion): SkeletalDivision {
  return AXIAL_REGIONS.has(region) ? 'axial' : 'appendicular';
}
