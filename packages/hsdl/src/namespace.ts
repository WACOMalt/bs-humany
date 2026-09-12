/**
 * The project's reverse-DNS namespace.
 *
 * Used wherever an identifier must be globally unique rather than merely unique within this
 * repository: JSON Schema `$id` URIs, HSDL extension namespaces, and persisted storage keys.
 *
 * The short workspace scope `@bs-humany/*` is for imports. This is for anything that might meet
 * an identifier minted by someone else.
 */
export const PROJECT_NAMESPACE = 'bsums.xyz.bs-humany';

/** Base URI for generated JSON Schema documents. */
export const SCHEMA_BASE_URI = 'https://bsums.xyz/bs-humany/schema';

/** The HSDL version this build reads and writes. */
export const HSDL_VERSION = '0.1';
