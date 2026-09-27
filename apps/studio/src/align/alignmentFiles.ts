/**
 * The Align tab's three files as data: what each says, how each is read back, and how a file
 * read back joins what is already on screen.
 *
 * Pure -- no page, no scene -- so the rules can be tested without a studio. The documents lived
 * inside the panel as three `JSON.stringify` calls, with nothing to read them back: a pairing that
 * took an afternoon existed only as a download, and a reload threw it away. Now every file the tab
 * writes it can also open, and the same three documents are what a reload restores from the
 * draft.
 *
 * Version 2 of each format adds provenance (see `provenance.ts`): the body the work was done
 * against, and which extraction of the reference models was on screen. Version-1 files are still
 * read; they simply carry none.
 */

import type { Pair } from './correspondence.js';
import type { HandleKind, Move } from './pointHandles.js';
import {
  type BodyStamp,
  type MorphologyInput,
  type SourceSitesStamp,
  bonePairingProvenance,
  correspondenceProvenance,
  overridesProvenance,
} from './provenance.js';
import type { BodyPair } from './retarget.js';

/** The formats this studio writes. */
export const ALIGN_FORMATS = {
  correspondence: 'bs-humany.source-correspondence/2',
  overrides: 'bs-humany.point-overrides/2',
  bones: 'bs-humany.bone-pairing/2',
} as const;

/** Every format this studio reads, the first versions included, by what they hold. */
const READABLE: Readonly<Record<string, 'correspondence' | 'overrides' | 'bones'>> = {
  'bs-humany.source-correspondence/1': 'correspondence',
  [ALIGN_FORMATS.correspondence]: 'correspondence',
  'bs-humany.point-overrides/1': 'overrides',
  [ALIGN_FORMATS.overrides]: 'overrides',
  'bs-humany.bone-pairing/1': 'bones',
  [ALIGN_FORMATS.bones]: 'bones',
};

/**
 * A bone pair as the tab keeps it: the pair, the profile it was made against, and who decided it.
 *
 * `decidedBy` is `name` for a pair Suggest by name proposed and `eye` for one a person made, so a
 * reader can tell a judgement from a string match. Both are absent on a version-1 file.
 */
export interface StampedBonePair extends BodyPair {
  readonly profile?: string;
  readonly decidedBy?: 'eye' | 'name';
}

/** What a file read back holds, or why it could not be read. */
export type AlignmentFile =
  | { readonly kind: 'correspondence'; readonly pairs: readonly Pair[] }
  | { readonly kind: 'overrides'; readonly moves: readonly Move[] }
  | {
      readonly kind: 'bones';
      readonly models: Readonly<Record<string, readonly StampedBonePair[]>>;
    }
  | { readonly error: string };

/** A document's text, as the tab saves it: pretty, with a final newline. */
export function serialise(document: object): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The correspondence document: which muscle of theirs is which of ours.
 *
 * It names the one consumer it is meant for and says that consumer does not read it yet, rather
 * than claiming, as the first version did, to be consumed by something that has never opened it.
 */
export function correspondenceDocument(input: {
  readonly pairs: readonly Pair[];
  readonly sourceSites: SourceSitesStamp | undefined;
  readonly profile: string | undefined;
  readonly decidedAt: string;
}): object {
  return {
    format: ALIGN_FORMATS.correspondence,
    decidedAt: input.decidedAt,
    note:
      'Which muscle of the reference models is which of ours. Decided by eye in the studio Align ' +
      'tab; many of theirs may map to one of ours. Intended for measure:source-travel, once it ' +
      'reads a mapping (docs/plans/dataset-correspondence.md, item 1.7).',
    ...correspondenceProvenance(input.sourceSites, input.profile),
    pairs: input.pairs,
  };
}

/** The point-overrides document: which of our points moved, how far, why, and on which body. */
export function overridesDocument(input: {
  readonly moves: readonly Move[];
  readonly body: BodyStamp | undefined;
  readonly decidedAt: string;
}): object {
  return {
    format: ALIGN_FORMATS.overrides,
    decidedAt: input.decidedAt,
    note:
      'Points moved by eye in the studio Align tab, judged against our own meshes. The reference ' +
      'model is context and was never the target. Each carries how far it moved, why, and the ' +
      'body it was moved on.',
    ...overridesProvenance(input.body),
    moves: input.moves,
  };
}

/** The bone-pairing document: which bone of each reference model is which of our segments. */
export function bonePairingDocument(input: {
  readonly models: ReadonlyMap<string, readonly StampedBonePair[]>;
  readonly body: BodyStamp | undefined;
  readonly sourceSites: SourceSitesStamp | undefined;
  readonly decidedAt: string;
}): object {
  return {
    format: ALIGN_FORMATS.bones,
    decidedAt: input.decidedAt,
    note:
      'Which bone of each reference model is which of ours. A pair fixes an origin and an ' +
      'orientation; the joints on that bone give it a scale. Each pair says whether a person ' +
      'decided it by eye or Suggest by name proposed it.',
    ...bonePairingProvenance(input.body, input.sourceSites),
    models: Object.fromEntries([...input.models].filter(([, list]) => list.length > 0)),
  };
}

// ---- reading back ------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPoint = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const KINDS: ReadonlySet<string> = new Set<HandleKind>(['joints', 'sites', 'vias']);

/**
 * Read an Align file back, whichever of the three it is.
 *
 * The format is checked exactly, as a session file's is: a file of another kind -- a session, a
 * recording -- is turned away by name rather than half-read. Every row must be whole: names are
 * non-empty strings and a position is three finite numbers, because a pair with an empty side or a
 * move to NaN would sit in the list looking like any other and fail only when used. One bad row
 * rejects the file, and the error names it.
 */
export function readAlignmentFile(text: string): AlignmentFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { error: `it is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isRecord(data)) return { error: 'it is not a JSON object' };
  const format = data.format;
  const kind = typeof format === 'string' ? READABLE[format] : undefined;
  if (!kind) {
    return {
      error:
        typeof format === 'string'
          ? `its format is ${format}, not one the Align tab writes`
          : 'it has no format, so it is not an Align file',
    };
  }
  if (kind === 'correspondence') {
    if (!Array.isArray(data.pairs)) return { error: 'it has no list of pairs' };
    const pairs: Pair[] = [];
    for (const [i, row] of data.pairs.entries()) {
      if (!isRecord(row) || !isName(row.theirs) || !isName(row.ours) || !isName(row.model)) {
        return { error: `pair ${i + 1} does not name theirs, ours and a model` };
      }
      pairs.push({ theirs: row.theirs, model: row.model, ours: row.ours });
    }
    return { kind, pairs };
  }
  if (kind === 'overrides') {
    if (!Array.isArray(data.moves)) return { error: 'it has no list of moves' };
    const moves: Move[] = [];
    for (const [i, row] of data.moves.entries()) {
      if (
        !isRecord(row) ||
        !isName(row.id) ||
        !isName(row.on) ||
        typeof row.kind !== 'string' ||
        !KINDS.has(row.kind)
      ) {
        return { error: `move ${i + 1} does not name a point, its kind and what it is on` };
      }
      if (!isPoint(row.from) || !isPoint(row.to)) {
        return { error: `move ${i + 1} (${row.id}) does not give from and to as three numbers` };
      }
      if (!isName(row.reason)) {
        return { error: `move ${i + 1} (${row.id}) does not say why it moved` };
      }
      const [fx, fy, fz] = row.from;
      const [tx, ty, tz] = row.to;
      moves.push({
        id: row.id,
        kind: row.kind as HandleKind,
        on: row.on,
        from: [fx, fy, fz],
        to: [tx, ty, tz],
        // Worked out again rather than trusted: it is only ever the distance between the two.
        moved: Number((1000 * Math.hypot(tx - fx, ty - fy, tz - fz)).toFixed(2)),
        reason: row.reason,
        ...(isName(row.profile) ? { profile: row.profile } : {}),
        ...(isRecord(row.morphology)
          ? { morphology: row.morphology as unknown as MorphologyInput }
          : {}),
      });
    }
    return { kind, moves };
  }
  if (!isRecord(data.models)) return { error: 'it has no bone pairs by model' };
  const models: Record<string, StampedBonePair[]> = {};
  for (const [model, list] of Object.entries(data.models)) {
    if (!Array.isArray(list)) return { error: `the ${model} bone pairs are not a list` };
    const out: StampedBonePair[] = [];
    for (const [i, row] of list.entries()) {
      if (!isRecord(row) || !isName(row.theirs) || !isName(row.ours)) {
        return { error: `${model} bone pair ${i + 1} does not name their bone and our segment` };
      }
      out.push({
        theirs: row.theirs,
        ours: row.ours,
        ...(isName(row.profile) ? { profile: row.profile } : {}),
        ...(row.decidedBy === 'eye' || row.decidedBy === 'name'
          ? { decidedBy: row.decidedBy }
          : {}),
      });
    }
    models[model] = out;
  }
  return { kind, models };
}

// ---- merging a file into what is on screen ----------------------------------------------

/** What opening a file did to one list. */
export interface MergeReport {
  /** Rows the file brought that were not here. */
  readonly added: number;
  /** Rows the file brought that replaced one here. */
  readonly replaced: number;
  /** Rows the file brought that were here already, exactly. */
  readonly already: number;
  /** Their-side names the reference model on screen does not have: dropped, by model. */
  readonly dropped: ReadonlyMap<string, readonly string[]>;
  /** Our-side ids the body on screen does not have: kept, and listed here. */
  readonly unknownOurs: readonly string[];
  /** False when there was no body to check our side against. */
  readonly oursChecked: boolean;
}

/**
 * What the reference data and the body can say about names, for a merge to check against.
 *
 * `theirs(model)` is the set of names that model has, or undefined when there is no such model.
 * `ours` is undefined before a body is built: our units and segments exist only once a run has
 * started, and differ by profile, so an our-side id is never dropped for being absent -- only
 * marked and counted.
 */
export interface KnownNames {
  readonly theirs: (model: string) => ReadonlySet<string> | undefined;
  readonly ours: ReadonlySet<string> | undefined;
}

class Tally {
  added = 0;
  replaced = 0;
  already = 0;
  readonly dropped = new Map<string, string[]>();
  readonly unknownOurs: string[] = [];
  constructor(private readonly known: KnownNames) {}
  /** Whether their name survives; a name that does not is recorded as dropped. */
  theirs(model: string, name: string): boolean {
    if (this.known.theirs(model)?.has(name)) return true;
    const list = this.dropped.get(model) ?? [];
    list.push(name);
    this.dropped.set(model, list);
    return false;
  }
  ours(id: string): void {
    if (this.known.ours && !this.known.ours.has(id) && !this.unknownOurs.includes(id)) {
      this.unknownOurs.push(id);
    }
  }
  report(): MergeReport {
    return {
      added: this.added,
      replaced: this.replaced,
      already: this.already,
      dropped: this.dropped,
      unknownOurs: this.unknownOurs,
      oursChecked: this.known.ours !== undefined,
    };
  }
}

/**
 * Add a file's muscle pairs: a union on the (model, theirs, ours) triple, since one of theirs may
 * be paired with several of ours and every such pair is its own decision.
 */
export function mergePairs(
  into: Pair[],
  incoming: readonly Pair[],
  known: KnownNames,
): MergeReport {
  const tally = new Tally(known);
  for (const p of incoming) {
    if (!tally.theirs(p.model, p.theirs)) continue;
    tally.ours(p.ours);
    if (into.some((q) => q.model === p.model && q.theirs === p.theirs && q.ours === p.ours)) {
      tally.already += 1;
    } else {
      into.push(p);
      tally.added += 1;
    }
  }
  return tally.report();
}

/**
 * Add a file's bone pairs: a replacement on (model, their bone), since one of their bones sits on
 * exactly one of our segments, as pairing by hand already treats it.
 */
export function mergeBonePairs(
  into: Map<string, StampedBonePair[]>,
  incoming: Readonly<Record<string, readonly StampedBonePair[]>>,
  known: KnownNames,
): MergeReport {
  const tally = new Tally(known);
  for (const [model, list] of Object.entries(incoming)) {
    for (const p of list) {
      if (!tally.theirs(model, p.theirs)) continue;
      tally.ours(p.ours);
      const here = into.get(model) ?? [];
      into.set(model, here);
      const at = here.findIndex((q) => q.theirs === p.theirs);
      if (at < 0) {
        here.push(p);
        tally.added += 1;
      } else if (here[at]?.ours === p.ours) {
        tally.already += 1;
      } else {
        here.splice(at, 1, p);
        tally.replaced += 1;
      }
    }
  }
  return tally.report();
}

/**
 * Add a file's moves: a replacement on the point's id, since a point has one place. Whether each
 * still fits the body on screen is the handles' question (`PointHandles.show` reports a move whose
 * `from` no longer matches as stale), so nothing is dropped here.
 */
export function mergeMoves(into: Move[], incoming: readonly Move[]): MergeReport {
  const tally = new Tally({ theirs: () => undefined, ours: undefined });
  for (const m of incoming) {
    const at = into.findIndex((q) => q.id === m.id);
    if (at < 0) {
      into.push(m);
      tally.added += 1;
    } else if (JSON.stringify(into[at]) === JSON.stringify(m)) {
      tally.already += 1;
    } else {
      into.splice(at, 1, m);
      tally.replaced += 1;
    }
  }
  return tally.report();
}

/**
 * One line saying what opening a file did: "Opened 48 pairs, 3 already here; 2 name a muscle the
 * torso model does not have: X, Y."
 */
export function describeMerge(
  report: MergeReport,
  rows: { readonly one: string; readonly many: string },
  theirThing: string,
  ourThing: string,
): string {
  const n = (count: number) => `${count} ${count === 1 ? rows.one : rows.many}`;
  const brought = report.added + report.replaced + report.already;
  const parts = [
    `Opened ${n(brought)}` +
      (report.replaced ? `, ${report.replaced} replacing one here` : '') +
      (report.already ? `, ${report.already} already here` : ''),
  ];
  for (const [model, names] of report.dropped) {
    parts.push(
      `${names.length} ${names.length === 1 ? 'names' : 'name'} ${theirThing} the ${model} ` +
        `model does not have, left out: ${names.join(', ')}`,
    );
  }
  if (report.unknownOurs.length > 0) {
    parts.push(
      `${report.unknownOurs.length} ${report.unknownOurs.length === 1 ? 'names' : 'name'} ` +
        `${ourThing} this body does not have, kept and marked ?`,
    );
  } else if (!report.oursChecked && brought > 0) {
    parts.push('our side is checked once a run has started');
  }
  return `${parts.join('; ')}.`;
}

// ---- the draft ---------------------------------------------------------------------------

/** Where the draft lives in the page's memory: one key for all three documents. */
export const DRAFT_KEY = 'align.draft';

/** The part of the page's memory a draft needs. */
export interface DraftStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** The three documents' texts, as saved, which is what a draft keeps. */
export interface DraftTexts {
  readonly correspondence: string;
  readonly overrides: string;
  readonly bones: string;
}

/** Keep the three documents as they stand, so a reload can offer them back. */
export function writeDraft(store: DraftStore, texts: DraftTexts): void {
  store.set(DRAFT_KEY, JSON.stringify(texts));
}

/** What a draft holds, read back through the same reader a file goes through. */
export interface Draft {
  readonly pairs: readonly Pair[];
  readonly moves: readonly Move[];
  readonly bones: Readonly<Record<string, readonly StampedBonePair[]>>;
}

/**
 * The draft kept by the last visit, or undefined when there is none or it holds nothing.
 *
 * Each document goes through `readAlignmentFile`, so a draft written by an older studio, or
 * damaged, is judged exactly as an opened file would be; a document that does not read is left
 * out rather than taking the other two with it.
 */
export function readDraft(store: DraftStore): Draft | undefined {
  const raw = store.get(DRAFT_KEY);
  if (!raw) return undefined;
  let texts: Partial<Record<keyof DraftTexts, unknown>>;
  try {
    texts = JSON.parse(raw) as typeof texts;
  } catch {
    return undefined;
  }
  const read = (text: unknown): AlignmentFile | undefined =>
    typeof text === 'string' ? readAlignmentFile(text) : undefined;
  const c = read(texts.correspondence);
  const o = read(texts.overrides);
  const b = read(texts.bones);
  const draft: Draft = {
    pairs: c && 'kind' in c && c.kind === 'correspondence' ? c.pairs : [],
    moves: o && 'kind' in o && o.kind === 'overrides' ? o.moves : [],
    bones: b && 'kind' in b && b.kind === 'bones' ? b.models : {},
  };
  const empty =
    draft.pairs.length === 0 &&
    draft.moves.length === 0 &&
    Object.values(draft.bones).every((list) => list.length === 0);
  return empty ? undefined : draft;
}
