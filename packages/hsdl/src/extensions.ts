/**
 * Extension namespaces.
 *
 * Spec section 14.5, obligation 3: a future module must be able to annotate HSDL without forking
 * the schema. A nerve module in 2027 needs to attach a root level and an innervation target to a
 * bone. It must not need a pull request against this package to do it.
 *
 * Every major HSDL node therefore carries an optional `ext` map. Keys are reverse-DNS namespaces,
 * so two modules written by people who never met cannot collide. Values are opaque to HSDL --
 * validated by the owning module, ignored by everything else, preserved verbatim through
 * serialization round-trips.
 *
 * The round-trip guarantee is the load-bearing part. A loader that silently drops unknown
 * extension data would destroy annotations belonging to a module that merely was not loaded at the
 * time, which is a data-loss bug that shows up long after the code that caused it.
 */

import { z } from 'zod';
import { PROJECT_NAMESPACE } from './namespace.js';

/**
 * Reverse-DNS namespace: at least two dot-separated segments, lowercase, hyphens allowed inside a
 * segment. `bsums.xyz.bs-humany.nerve` is valid. `nerve` is not -- an unqualified key is exactly
 * the kind that collides.
 */
export const EXTENSION_NAMESPACE_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const ExtensionsSchema = z
  .record(
    z
      .string()
      .regex(
        EXTENSION_NAMESPACE_PATTERN,
        'Extension keys must be reverse-DNS namespaces with at least two segments, for example ' +
          `'${PROJECT_NAMESPACE}.nerve'. An unqualified key risks colliding with another module.`,
      ),
    z.unknown(),
  )
  .optional();

export type Extensions = Record<string, unknown> | undefined;

/** Namespace for a first-party module of this project. */
export function moduleNamespace(module: string): string {
  return `${PROJECT_NAMESPACE}.${module}`;
}

/**
 * Read a namespaced extension value, narrowed by a caller-supplied schema.
 *
 * Returns `undefined` when the namespace is absent, and throws when it is present but malformed.
 * The distinction matters: absent means "this module never annotated this node", malformed means
 * "this module wrote something it cannot read back", and conflating them hides the second.
 */
export function readExtension<T>(
  extensions: Extensions,
  namespace: string,
  schema: z.ZodType<T>,
): T | undefined {
  const raw = extensions?.[namespace];
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Extension '${namespace}' is present but does not match its schema: ` +
        `${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

/** Write a namespaced extension value, returning a new map. Does not mutate. */
export function writeExtension(
  extensions: Extensions,
  namespace: string,
  value: unknown,
): Record<string, unknown> {
  if (!EXTENSION_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `'${namespace}' is not a valid extension namespace. Use reverse-DNS with at least two ` +
        `segments, for example '${PROJECT_NAMESPACE}.nerve'.`,
    );
  }
  return { ...(extensions ?? {}), [namespace]: value };
}
