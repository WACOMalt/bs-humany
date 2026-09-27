/**
 * The reference body: the one morphology and the one profile that everything measured, validated
 * or trained without naming a body of its own is measured, validated or trained on.
 *
 * L3 is the reference profile. It is the one that gives every bone that moves on its own a body of
 * its own, so it is the one the anatomy is got right on first, and the one the committed
 * measurements are taken on: the muscle ranges in `muscle-data/src/ranges.ts`, the source travel
 * in `muscle-data/src/sourceTravel.ts`, and the moment-arm and obligation reports in
 * `docs/validation`. The morphology is the document's default, the scenarios' body, the body those
 * tools measure, and the body the training rig stands up when neither the recipe nor its scenario
 * names one.
 *
 * Each of those used to spell the body out again as `{ sex: 0.5, stature: 1.7, mass: 70 }`, a copy
 * per reader. They agreed only because nobody had changed one, and a change to one would have
 * moved the document's default without moving the tables measured against it, which is the quiet
 * disagreement this file exists to make impossible. It imports nothing that runs, so a tool that
 * loads the package through jiti pays nothing extra for it.
 *
 * These are the morphology's inputs, not measurements: `@bs-humany/anthropometry` resolves them
 * into a body and carries the sources for what they resolve to. Frozen, because the document hands
 * this object out as its default, and a caller that edited that default in place would otherwise
 * move every other reader's reference body with it.
 */

import type { Morphology } from '@bs-humany/hsdl';

/** The reference morphology: a sex-blended adult, 1.7 m tall, 70 kg. */
export const REFERENCE_MORPHOLOGY: Morphology = Object.freeze({ sex: 0.5, stature: 1.7, mass: 70 });

/** The reference profile, `L3 — Anatomical`. */
export const REFERENCE_PROFILE = 'l3_anatomical' as const;
