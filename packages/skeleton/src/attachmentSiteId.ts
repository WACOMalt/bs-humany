/**
 * How an attachment site is named, in one place the muscle generators can load on their own.
 *
 * `attachments.ts` builds the sites every body carries, and the muscle-data files bind to them by
 * id. Those files are written by generators in `tools/cli/bin`, four of which used to spell the
 * ids out again with string templates of their own: the hand's restated the rule that a path site
 * carries its bone and an attachment does not, and the neck's lower-cased a feature where the
 * package sanitises it, which agrees only while the feature's name has no bracket or hyphen. The
 * scheme lives here instead, and so do the wrist compartments the hand's tendons are routed
 * through, which the hand generator used to copy out by hand.
 *
 * This module imports nothing, not even the dataset, so a generator can load it through jiti
 * without reading a single mesh table.
 */

/**
 * The feature half of a landmark or site id: brackets dropped, hyphens made underscores, anything
 * else outside `[A-Za-z0-9_]` dropped, lower case.
 *
 * `landmarkId` uses it for `<bone>__<feature>` and `attachmentSiteId` for the tail of a site id, so
 * a site and the landmark it stands on spell the feature the same way. It is idempotent: an
 * already-sanitised name comes back unchanged, which is what lets a generator pass either.
 */
export function sanitizeFeatureId(feature: string): string {
  return feature
    .replace(/[()]/g, '')
    .replace(/-/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase();
}

/** What a site is to its muscle, as it appears in the site's id. */
export type AttachmentRole = 'origin' | 'insertion' | 'ligament' | 'path';

/**
 * The id of a muscle's attachment site: `<muscle>_<role>_<side>_<feature>`, and for a path site
 * `<muscle>_path_<side>_<bone>_<feature>`.
 *
 * A path site carries the bone it is on, and an attachment does not. A tendon passes the same
 * *named feature* on several bones -- a finger flexor crosses the flexor side of the head of the
 * metacarpal and of two phalanges -- and without the bone in the id those are one id, so two of
 * the three points vanish into the builder's dedupe and the tendon cuts the corner it was
 * supposed to be held around. An attachment has no such problem: a muscle attaches to one bone by
 * one feature, and the shorter id is the one every muscle data file already names.
 *
 * `side` is `r`, `l`, or `$` in a generator's template that is sided afterwards. The bone's own
 * side suffix is dropped, since the side is already in the id; `bone` may be null for a role that
 * does not use it. `feature` is sanitised by `sanitizeFeatureId`, so either the dataset's name or
 * an already-sanitised one gives the same id.
 *
 * A double underscore in a feature's name sets off which part of the named feature was measured
 * -- `Lateral_supracondylar_ridge__upper_two_thirds` is the stretch of the ridge brachioradialis
 * arises from -- and the id stops before it, so the site keeps the plain feature's name. That is
 * the name the muscle data binds to. The id used to be cut out of a landmark id at the `__` that
 * `landmarkId` puts between bone and feature, which took the qualifier with it, and a site id is
 * bound by name, so the rule stays and is written down here.
 */
export function attachmentSiteId(
  muscle: string,
  role: AttachmentRole,
  side: string,
  bone: string | null,
  feature: string,
): string {
  const featureId = sanitizeFeatureId(feature).split('__')[0];
  if (role !== 'path') return `${muscle}_${role}_${side}_${featureId}`;
  if (bone === null) throw new Error(`${muscle}: a path site needs the bone it is on.`);
  const suffix = `_${side}`;
  const boneStem = bone.endsWith(suffix) ? bone.slice(0, -suffix.length) : bone;
  return `${muscle}_path_${side}_${boneStem}_${featureId}`;
}

/**
 * Where a tendon crosses the wrist: the compartment it runs in, as `[bone, feature]` with `$` for
 * the side.
 *
 * The flexors pass through the carpal tunnel, which the hook of the hamate bounds on the ulnar
 * side. The extensors run under the extensor retinaculum, and each is routed by the bony feature
 * beside its compartment: the radial styloid for the first compartment's two thumb tendons, the
 * dorsal radial tubercle for extensor pollicis longus -- and, standing in for their own
 * compartment, the finger extensors -- and the head of the ulna for extensor carpi ulnaris and
 * extensor digiti minimi. `attachments.ts` places a path site at each, and the hand generator
 * names the same sites, so both read them from here.
 */
export const CARPAL_TUNNEL: readonly [string, string] = ['hamate_$', 'Hook_of_hamate_bone'];
export const FIRST_COMPARTMENT: readonly [string, string] = ['radius_$', 'Radial_styloid_process'];
export const LISTERS_TUBERCLE: readonly [string, string] = ['radius_$', 'Dorsal_radial_tubercle'];
export const ULNAR_COMPARTMENT: readonly [string, string] = ['ulna_$', 'Head_of_ulna'];
