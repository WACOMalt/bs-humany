/**
 * Citations.
 *
 * CONTRIBUTING rule 3: a number without a source is a bug. This type is how a source travels with
 * a value, and `pnpm cite:lint` is what makes the rule enforceable rather than aspirational.
 *
 * The `key` resolves against `docs/sources/bibliography.md`. The `locator` names the table, figure
 * or section the number was read from -- specific enough that a reviewer can find it without
 * re-reading the paper. A citation with no locator is legal but weak, and review should push back
 * on one attached to a parameter table.
 */

import { z } from 'zod';

export const CitationSchema = z
  .object({
    /** Bibliography key: lowercase first-author surname plus year, e.g. `deleva1996`. */
    key: z
      .string()
      .regex(
        /^[a-z][a-z0-9]*\d{4}[a-z]?$/,
        'Citation keys are a lowercase surname followed by a four-digit year, optionally ' +
          'disambiguated by a trailing letter. For example: deleva1996, wu2005, gordon2014.',
      ),
    /** Where in the source the value came from. */
    locator: z.string().min(1).optional(),
    /**
     * Set when the value is not actually sourced and is recorded as an open question.
     *
     * This exists so that "we could not find a source" is representable *in the data* rather than
     * being quietly papered over with a plausible number. ADR-009 and CONTRIBUTING rule 4: when
     * validation reveals a gap, the resolution is a citable source or an open question -- never a
     * value copied from a non-permissively-licensed reference model.
     */
    provisional: z
      .object({
        /** Identifier in `docs/sources/open-questions.md`, e.g. `OQ-004`. */
        openQuestion: z.string().regex(/^OQ-\d{3,}$/),
        /** Why the current value is defensible in the meantime. */
        rationale: z.string().min(1),
      })
      .optional(),
  })
  .strict();

z.globalRegistry.add(CitationSchema, { id: 'Citation' });

export type Citation = z.infer<typeof CitationSchema>;

/**
 * Build a citation.
 *
 * The spelling `cite('wu2002', 'Table 1, hip flexion/extension')` is what `cite-lint` scans for,
 * so prefer it over writing the object literal by hand.
 */
export function cite(key: string, locator?: string): Citation {
  return locator === undefined ? { key } : { key, locator };
}

/**
 * Build a citation for a value that has no source yet.
 *
 * Deliberately more verbose than `cite`, because reaching for it should feel like the compromise
 * it is. The open question must already exist in `docs/sources/open-questions.md`.
 */
export function provisional(
  key: string,
  openQuestion: string,
  rationale: string,
  locator?: string,
): Citation {
  return {
    key,
    ...(locator === undefined ? {} : { locator }),
    provisional: { openQuestion, rationale },
  };
}

/** True when the citation is a real source rather than a recorded gap. */
export function isSourced(citation: Citation): boolean {
  return citation.provisional === undefined;
}
