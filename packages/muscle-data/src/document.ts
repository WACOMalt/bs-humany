/**
 * The muscle set inside an HSDL document, which is where muscle spec 10.3 says it lives.
 *
 * Base spec 14.5 obligation 3 built extension namespaces so a module could annotate a document
 * without forking HSDL, and `schema.ts` defined the muscle extension in exactly those terms. N3.5
 * then found nothing ever put a muscle set into a document: every run handed the definitions to
 * the compiler beside the document instead of inside it. The schema described a place the data
 * never went, so a document carried its bones, its attachment sites and its wrapping surfaces
 * but not the muscles that are the reason two of those three exist.
 *
 * These two functions are that place being used. A document now carries its own muscles, so a
 * document that defines a different set -- fewer units, another region, another person -- gets
 * that set rather than the built-in one, and a tool that edits bones without knowing what a
 * muscle is keeps them, because HSDL preserves extension data it does not understand.
 */

import { type Extensions, readExtension, writeExtension } from '@bs-humany/hsdl';
import {
  MUSCLE_NAMESPACE,
  MUSCLE_SCHEMA_VERSION,
  type MuscleExtension,
  MuscleExtensionSchema,
  type MuscleGroup,
} from './schema.js';
import { ALL_MUSCLES } from './wholeBody.js';

/** The one part of a document these read and write: its top-level extension map. */
interface Extensible {
  readonly ext?: Extensions;
}

/**
 * A copy of the document carrying a muscle set, by default the whole body.
 *
 * Any muscle set already there is replaced, and every other module's extension is kept. Does not
 * mutate: the document a caller passed in is the one it had.
 */
export function withMuscles<D extends Extensible>(
  document: D,
  groups: readonly MuscleGroup[] = ALL_MUSCLES,
): D {
  const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...groups] };
  return { ...document, ext: writeExtension(document.ext, MUSCLE_NAMESPACE, extension) };
}

/**
 * The muscle set a document carries, checked against the schema.
 *
 * `undefined` when there is none, and a throw naming the problem when there is one that does not
 * parse -- the distinction `readExtension` keeps, because a document with no muscles is a choice
 * and one with broken muscles is a fault. Cross-references to sites and surfaces are a separate
 * question, answered by `validateMuscleExtension`.
 */
export function readMuscles(document: Extensible): MuscleExtension | undefined {
  return readExtension(document.ext, MUSCLE_NAMESPACE, MuscleExtensionSchema);
}
