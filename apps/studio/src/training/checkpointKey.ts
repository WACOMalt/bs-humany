/**
 * What a checkpoint is, as opposed to what the list it is in happens to call it.
 *
 * Two lists feed the Brain panel and they name things differently. The dashboard names a file by
 * its path under the data folder -- `policies/stand.json`, `runs/stand-centre.json` -- and the
 * studio on its own names a checkpoint by its bare name, `stand`, because that is what its own
 * store and the shipped set key by. So the moment a server starts or stops, every id in the list
 * changes, and a selection kept by id quietly fell back to None each time.
 *
 * The name is the identity. `policies/stand.json` and `stand` are one checkpoint, and the local
 * list already resolves which `stand` that is (a name trained here wins over the shipped one of
 * the same name, because a person who retrained `stand` means the one they retrained). A search
 * centre is kept apart: it is the middle of a run's search, not the policy the run saved, and
 * only a server lists it, so the key says which of the two it is.
 */

/** The file name without its folder or its `.json`: what both lists agree a checkpoint is called. */
export function checkpointStem(id: string): string {
  const base = id.slice(id.lastIndexOf('/') + 1);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

/** `centre:<stem>` for a run's search centre, `policy:<stem>` for everything else. */
export function checkpointKey(id: string): string {
  return `${id.startsWith('runs/') ? 'centre' : 'policy'}:${checkpointStem(id)}`;
}

/**
 * The id to select in a new list: the same id when it is there, else the one with the same key,
 * else nothing. The exact id first, so a list that holds both spellings keeps the one chosen.
 */
export function reselect(
  rows: readonly { readonly id: string }[],
  chosenId: string,
  chosenKey: string,
): string {
  if (chosenId !== '' && rows.some((r) => r.id === chosenId)) return chosenId;
  if (chosenKey === '') return '';
  return rows.find((r) => checkpointKey(r.id) === chosenKey)?.id ?? '';
}
