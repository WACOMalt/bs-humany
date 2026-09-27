/**
 * The Align tab's pairing lists as data: which of their muscles are paired, what a row says, and
 * which bone pairs point at segments the body on screen does not have.
 *
 * Pure, with no page and no scene, so the rules the lists follow can be tested without a studio.
 * The lists got each of these wrong while the rules lived inside the panel: a row was found again
 * by its muscle alone, so Unpair took the first of two rows for one muscle rather than the one
 * picked; the grey-out was keyed by the muscle's name alone, so a muscle of one model greyed a
 * namesake in another; and a bone pair made against a fuller body sat in the list looking as good
 * as any other when the body built since has no such segment.
 */

import type { BodyPair } from './retarget.js';

export interface Pair {
  /** Their muscle, by the name the reference model gives it. */
  readonly theirs: string;
  /** Which reference model it came from. */
  readonly model: string;
  /** Our unit id. */
  readonly ours: string;
}

/**
 * Their muscles paired so far on one reference model.
 *
 * By model, because two models may use one name -- a strip of the oblique in the torso and a
 * muscle of the same name in the legs are different muscles -- and each model's list and grey-out
 * should show only what was decided on that model.
 */
export function pairedIn(pairs: readonly Pair[], model: string): Set<string> {
  const out = new Set<string>();
  for (const p of pairs) if (p.model === model) out.add(p.theirs);
  return out;
}

/**
 * What a muscle pair's row says: the model, their muscle and ours.
 *
 * The model is named because the list holds pairs from every model at once, and the same muscle
 * name on two of them would otherwise read as one row twice.
 */
export function pairLabel(p: Pair): string {
  return `${p.model}: ${p.theirs} → ${p.ours}`;
}

/**
 * Take out the pair at one index in the list, and give it back.
 *
 * By index, because a row is not identified by any of its fields alone: one of theirs may be
 * paired with several of ours, and one of ours with several of theirs. Undefined for an index
 * that is not in the list, which is left alone.
 */
export function unpairAt(pairs: Pair[], index: number): Pair | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= pairs.length) return undefined;
  return pairs.splice(index, 1)[0];
}

/**
 * The bone pairs whose segment of ours is not in the body now built.
 *
 * A pair is kept when the body is rebuilt at a profile without its segment, rather than dropped,
 * because going back to the fuller body should not lose it. It fits nothing meanwhile, so the list
 * says which pairs those are and the redraw says why the muscles over them were left out.
 */
export function missingSegments(
  bonePairs: readonly BodyPair[],
  segmentIds: ReadonlySet<string>,
): BodyPair[] {
  return bonePairs.filter((p) => !segmentIds.has(p.ours));
}
