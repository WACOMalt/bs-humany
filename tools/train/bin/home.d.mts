/** Types for `home.mjs`, which is plain JavaScript because the Node entry points import it directly. */

/** The data directory: `BS_HUMANY_HOME`, or the one the operating system means for this. */
export function dataHome(): string;
/** `<data>/policies`, made if it is not there. */
export function policiesDir(): string;
/** `<data>/runs`, made if it is not there. */
export function runsDir(): string;
/** `<data>/runs/<name>-<kind>.json`, a run's centre or progress; the path only, nothing made. */
export function runFile(name: string, kind: 'centre' | 'latest'): string;
/** `<data>/policies/<name>-<kind>.json`, where the studio binary once kept them; read, never written. */
export function formerRunFile(name: string, kind: 'centre' | 'latest'): string;
/** Copy the repository's shipped checkpoints in, once, on a machine that has none. */
export function seedFromRepository(repositoryPolicies: string): string;
