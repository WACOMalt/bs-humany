/**
 * The checkpoints that ship with the studio.
 *
 * A binary that trains its own nerves should arrive with something already trained, the way it
 * arrives with a skeleton and a muscle set: a person who opens it should be able to hand a
 * policy to a body without first running a search. So the policy files in
 * `packages/modules-nerves/policies` are part of the bundle.
 *
 * Lazily, and cached after the first ask. Half a megabyte of weights is not worth loading to
 * draw a panel nobody has opened, and the panel asks for this list every few seconds.
 */

import type { PolicyFile } from '@bs-humany/modules-nerves';

const FILES = import.meta.glob<{ default: PolicyFile }>(
  '../../../../packages/modules-nerves/policies/*.json',
);

let cache: readonly { readonly name: string; readonly file: PolicyFile }[] | undefined;

/** Every shipped checkpoint, by the name its file has. */
export async function shippedCheckpoints(): Promise<
  readonly { readonly name: string; readonly file: PolicyFile }[]
> {
  if (cache) return cache;
  const loaded = await Promise.all(
    Object.entries(FILES).map(async ([path, load]) => {
      const name =
        path
          .split('/')
          .pop()
          ?.replace(/\.json$/, '') ?? path;
      try {
        return { name, file: (await load()).default };
      } catch {
        return undefined;
      }
    }),
  );
  cache = loaded.filter((row): row is { name: string; file: PolicyFile } => row !== undefined);
  return cache;
}

/** One shipped checkpoint by name, or nothing when the studio does not carry it. */
export async function shippedCheckpoint(name: string): Promise<PolicyFile | undefined> {
  return (await shippedCheckpoints()).find((row) => row.name === name)?.file;
}
