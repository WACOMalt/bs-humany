/**
 * What an Align file was made against: the body on screen, and the reference data beside it.
 *
 * A pairing or a moved point is a judgement made by looking at two things at once, and the file it
 * is saved to is only readable later if it says which two. A point moved on the L3 body at one
 * stature is a different claim from the same id moved on L2 at another -- joint centres and sites
 * are placed from the morphology -- and a muscle paired against one extraction of the reference
 * models may name a path a later extraction redrew. So every file carries the body it was made on
 * and, where their side is involved, a digest of the `sourceSites.json` that was on screen.
 *
 * No dependency on the testkit's hashing: the studio ships to the browser and the headset, and a
 * thirty-two-bit FNV-1a over the file's bytes is enough to tell two extractions apart, which is
 * all it is for. It is not a security property.
 */

import type { ResolvedMorphology } from '@bs-humany/anthropometry';

/** The morphology a body was compiled at, in the shape a recording export already writes. */
export type MorphologyInput = ResolvedMorphology['input'];

/** The body an Align judgement was made against: its fidelity profile and its morphology. */
export interface BodyStamp {
  readonly profile: string;
  readonly morphology: MorphologyInput;
}

/** Which extraction of the reference models was on screen: its declared format and a digest. */
export interface SourceSitesStamp {
  readonly format: string;
  /** `fnv1a32` of the file's text, as eight hex digits. */
  readonly digest: string;
}

/** FNV-1a's 32-bit offset basis and prime (Fowler, Noll and Vo; IETF draft-eastlake-fnv). */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the UTF-8 bytes of a text, as eight lower-case hex digits.
 *
 * Over the bytes rather than the UTF-16 code units JavaScript stores, so the digest is the one any
 * other tool computes from the file on disk.
 */
export function fnv1a32(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The provenance header of a point-overrides file: the body the points were judged on.
 *
 * Null when no body was built, which the panel never saves from but a draft may carry: absent
 * provenance written down as absent, rather than left out and later mistaken for a file too old to
 * have any.
 */
export function overridesProvenance(body: BodyStamp | undefined): { body: BodyStamp | null } {
  return { body: body ?? null };
}

/**
 * The provenance header of a bone-pairing file: both sides, because a bone pair names one bone of
 * theirs and one segment of ours.
 */
export function bonePairingProvenance(
  body: BodyStamp | undefined,
  sourceSites: SourceSitesStamp | undefined,
): { body: BodyStamp | null; sourceSites: SourceSitesStamp | null } {
  return { body: body ?? null, sourceSites: sourceSites ?? null };
}

/**
 * The provenance header of a correspondence file: their side, and the profile our unit list came
 * from. The morphology is left out on purpose -- which muscle is which does not depend on stature,
 * but which units exist depends on the profile.
 */
export function correspondenceProvenance(
  sourceSites: SourceSitesStamp | undefined,
  profile: string | undefined,
): { sourceSites: SourceSitesStamp | null; profile: string | null } {
  return { sourceSites: sourceSites ?? null, profile: profile ?? null };
}
