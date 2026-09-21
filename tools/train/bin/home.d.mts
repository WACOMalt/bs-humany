/** Types for `home.mjs`, which is plain JavaScript because the Node entry points import it directly. */

/** The data directory: `BS_HUMANY_HOME`, or the one the operating system means for this. */
export function dataHome(): string;
/** `<data>/policies`, made if it is not there. */
export function policiesDir(): string;
/** `<data>/runs`, made if it is not there. */
export function runsDir(): string;
/** Copy the repository's shipped checkpoints in, once, on a machine that has none. */
export function seedFromRepository(repositoryPolicies: string): string;
