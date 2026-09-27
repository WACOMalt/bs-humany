/**
 * The key a segment's bone set is filed under in `hulls.json`.
 *
 * It lives in a module of its own, with no imports, because two sides need the same definition:
 * the skeleton looks a segment's hulls up by it (`hulls.ts`), and `tools/ingest/src/hulls.ts`
 * files each decomposition under it. The tool cannot import `hulls.ts` for it, since that module
 * imports the very `hulls.json` the tool is about to rewrite -- and a tool that cannot load until
 * its own output exists and parses cannot regenerate it. Two copies of the key, the way it was
 * before, would drift apart silently: every lookup would then miss and fall back to a primitive.
 */

/** `anchor|sorted,bone,ids`: the anchor bone, then the group's bones in sorted order. */
export function hullGroupKey(anchor: string, bones: readonly string[]): string {
  return `${anchor}|${[...bones].sort().join(',')}`;
}
