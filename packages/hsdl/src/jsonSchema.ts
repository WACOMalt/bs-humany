/**
 * JSON Schema generation.
 *
 * Spec section 5.1: the JSON Schema is **generated from the TypeScript types, not maintained by
 * hand.** A hand-written schema beside a TypeScript type is two sources of truth that agree until
 * the day they quietly do not, and the disagreement surfaces as a document that validates in one
 * place and fails in another.
 *
 * So the Zod schema is the single definition, TypeScript types are inferred from it, and the JSON
 * Schema is emitted from it. One thing to edit, three consistent outputs.
 */

import { z } from 'zod';
import { HsdlDocumentSchema } from './document.js';
import { HSDL_VERSION, SCHEMA_BASE_URI } from './namespace.js';

/**
 * Emit the JSON Schema for an HSDL document.
 *
 * `io: 'input'` matters: the document schema has defaults, and the input form is what a document
 * on disk must satisfy. Emitting the output form would produce a schema that rejects valid files
 * for omitting a field the parser fills in.
 */
export function generateJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(HsdlDocumentSchema, {
    target: 'draft-2020-12',
    io: 'input',
    // Recursive definitions (ScalarExpr, GeometryRecipe) must become $refs rather than being
    // inlined, or generation would not terminate.
    reused: 'ref',
  }) as Record<string, unknown>;

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_BASE_URI}/hsdl-${HSDL_VERSION}.json`,
    title: `HSDL ${HSDL_VERSION}`,
    description:
      'HumanSim Description Language: the canonical body model for bs-humany. Generated from ' +
      'the Zod schemas in @bs-humany/hsdl. Do not edit by hand -- regenerate with ' +
      '`pnpm --filter @bs-humany/hsdl generate:schema`.',
    ...schema,
  };
}
