/** Types for `checkpointName.mjs`, which is plain JavaScript so every side can import it as it is. */

/** A checkpoint's name: up to forty lower-case letters, digits, dashes and underscores. */
export const CHECKPOINT_NAME: RegExp;
/** Whether `name` is one a checkpoint may have. */
export function isCheckpointName(name: unknown): name is string;
/** The one sentence to show when `name` is not a checkpoint name, or undefined when it is. */
export function checkpointNameProblem(name: unknown): string | undefined;
