/**
 * The checkpoints that ship with the studio.
 *
 * A binary that trains its own nerves should arrive with something already trained, the way it
 * arrives with a skeleton and a muscle set: a person who opens it should be able to hand a
 * policy to a body without first running a search. So the policy files in
 * `packages/modules-nerves/policies` are part of the bundle.
 *
 * Since the owner's decision of 2026-09-27 there is one: `balance`, the default behaviour
 * (`DEFAULT_BEHAVIOUR` in the training recipe module), trained in "Drop, standing" at 0 m just far
 * enough to save a checkpoint, for the owner to train on. The five shipped before it -- stand,
 * stand-l1, balance, balance2 and balance_tiltingfloor -- were trained before the current cord,
 * the hand muscles and the sense fixes, and were retired rather than retrained.
 *
 * Lazily, and cached after the first ask. Half a megabyte of weights is not worth loading to
 * draw a panel nobody has opened, and the panel asks for this list every few seconds.
 */

import type { PolicyFile } from '@bs-humany/modules-nerves';
import { MUSCLE_GROUPS } from '@bs-humany/scenarios';

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

/**
 * The two changes to the body since the shipped checkpoints were trained, by the commits that made
 * them. A checkpoint trained before either was scored in a body that no longer runs: its fitness
 * is that body's, and what it does in this one is only the part of it that still fits.
 *
 * - The hand muscles, ed636ed ("The fingers and toes get muscles, and joints their muscles can
 *   work"): four new drive groups for the fingers and thumb, and two for the toes, that an older
 *   policy has no weights for, so they start silent under it.
 * - The cord as it is now, ba50a95 ("The stretch reflex reacts to stretch"): before it the
 *   afferent was normalised twice and read every muscle as hugely stretched, so a policy trained
 *   over that cord, or over none, learned to stand on a body that did not answer its own stretch.
 */
const HANDS_ARRIVED = Date.parse('2026-09-22T16:01:39-04:00');
const CORD_MEASURED = Date.parse('2026-09-22T18:53:58-04:00');

/** The drive groups of the hand, by the id a policy's outputs are named for. */
const HAND_DRIVES = new Set(MUSCLE_GROUPS.filter((g) => g.section === 'Hand').map((g) => g.id));

/**
 * What a checkpoint was trained before, in words for the list -- `the current cord and the hand
 * muscles` -- or undefined when it was trained in the body as it is.
 *
 * By when it was trained, where its file says, against the two commits above. A file that does
 * not say when is read by what it carries instead: no cord in its recipe, no hand drive among its
 * outputs. Nothing about the file is changed; the studio only says what it is. The checkpoint
 * shipped today is dated after both, so it says nothing; the words are for a checkpoint trained
 * elsewhere and handed to this studio, and for any older file a person keeps.
 */
export function trainedBefore(
  file: Pick<PolicyFile, 'trained' | 'recipe' | 'outputs'>,
): string | undefined {
  const at = file.trained ? Date.parse(file.trained.at) : Number.NaN;
  const dated = Number.isFinite(at);
  const beforeCord = dated ? at < CORD_MEASURED : !file.recipe?.reflex;
  const beforeHands = dated
    ? at < HANDS_ARRIVED
    : !(file.outputs ?? []).some((o) => HAND_DRIVES.has(o.split(':')[0] ?? ''));
  const what = [beforeCord ? 'the current cord' : '', beforeHands ? 'the hand muscles' : ''].filter(
    (w) => w !== '',
  );
  return what.length === 0 ? undefined : what.join(' and ');
}
