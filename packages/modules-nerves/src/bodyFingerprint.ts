/**
 * Which body a policy was trained in, short enough to write into every checkpoint.
 *
 * A policy is matched to a body by the names of its senses and drives (`MlpPolicy.fit`), and
 * names are all it is matched by. That is what lets a checkpoint trained on a coarser profile
 * carry onto a finer one, and it is also a hole: a sense whose meaning changes but whose name
 * does not -- a spin that starts arriving in the segment's own frame instead of the world's, a
 * load that starts being scaled differently -- is fed to the old weights as though nothing had
 * happened, and the policy that stood the body yesterday falls over today with nothing to say
 * why. The same goes for a muscle whose force was corrected, a step rate that was changed, or a
 * cord that was turned on underneath it.
 *
 * So a checkpoint says what it was trained in, and a body it is handed to compares. The
 * fingerprint is small on purpose: hashes where the thing is long (the sense list, the drive
 * list, every muscle's numbers), the thing itself where it is short and a person wants to read
 * it (the profile, the step, the cord). It is never a reason to refuse a checkpoint -- a policy
 * in a slightly different body is often exactly what somebody wants to try -- only to say so.
 *
 * Pure, and computed once when a body is built or a policy handed over; never inside `step`.
 */

import type { CompiledMuscleUnit } from '@bs-humany/modules-muscle';
import type { SpinalGains } from './spinalModule.js';

/** Bumped when the fingerprint's own fields change, so an old one is not misread as a new one. */
export const BODY_FINGERPRINT_VERSION = 1;

/**
 * What each sense means, as a version number, beside the observation it describes.
 *
 * Keyed by the sense's family -- the part of its name before the joint, group or axis:
 * `angle` for every `angle:<joint>:<axis>`, `pelvis.localSpin` for its three axes, `goal` for
 * every `goal[<n>]` -- or by a single sense's whole name, which wins over its family. Every sense
 * the observation (`observation.ts`) builds today is meaning 1.
 *
 * This table is what a sense fix bumps when it keeps the sense's name. Every checkpoint written
 * before the bump then says, when handed to the fixed body, that it was trained on the old meaning
 * of those senses, by name -- which is the one thing `MlpPolicy.fit`, matching by name alone,
 * could never have noticed. A sense renamed instead needs no bump: the fit already drops what it
 * cannot find, and says how many. The sense fixes of 2026-09-27 renamed: `pelvis.down`,
 * `pelvis.spin`, `pelvis.velocity`, `head.down` and `head.spin` became `localDown`, `localSpin`
 * and `localVelocity` when the rotation into the segment's frame was corrected, `foot.<side>.load`
 * became `foot.<side>.weight` when it became a share of body weight, and `stretch` became `strain`
 * when it stopped dividing by the optimal length twice.
 */
export const SENSE_MEANINGS: Readonly<Record<string, number>> = {
  // Proprioception: joint angles, and their rates scaled by a tenth.
  angle: 1,
  rate: 1,
  // The pelvis: world down, spin and velocity in its own frame, and its height.
  'pelvis.localDown': 1,
  'pelvis.localSpin': 1,
  'pelvis.localVelocity': 1,
  'pelvis.height': 1,
  // The head: height, and the down and spin in its own frame that stand in for the vestibular
  // sense.
  'head.height': 1,
  'head.localDown': 1,
  'head.localSpin': 1,
  // The soles: how many contacts, and the share of the body's weight they carry.
  'foot.left.contacts': 1,
  'foot.left.weight': 1,
  'foot.right.contacts': 1,
  'foot.right.weight': 1,
  // Per muscle group: efference copy, spindle II, spindle Ia, Golgi Ib.
  activation: 1,
  strain: 1,
  shorten: 1,
  load: 1,
  // What the person wants the body doing, and the policy's own context units.
  goal: 1,
  context: 1,
};

/**
 * The family a sense's name belongs to: before the first colon for the joint and group senses,
 * before the index for `goal[n]` and `context[n]`, without the axis for a vector's components.
 */
export function senseFamily(name: string): string {
  const colon = name.indexOf(':');
  if (colon >= 0) return name.slice(0, colon);
  const indexed = /^(.*)\[\d+\]$/.exec(name);
  if (indexed) return indexed[1] as string;
  const axis = /^(.*)\.[xyz]$/.exec(name);
  if (axis) return axis[1] as string;
  return name;
}

/** A sense's meaning version: its own entry, else its family's, else 1. */
export function senseMeaning(
  name: string,
  meanings: Readonly<Record<string, number>> = SENSE_MEANINGS,
): number {
  return meanings[name] ?? meanings[senseFamily(name)] ?? 1;
}

/** What a fingerprint is taken from: everything a policy experiences of the body it is in. */
export interface BodyDescription {
  /** The fidelity profile the articulation was compiled for. */
  readonly profile: string;
  /** Seconds a tick. */
  readonly dtSeconds: number;
  /** Ticks between policy evaluations. */
  readonly controlDivisor: number;
  /** The policy's inputs, by name, context units included. */
  readonly senses: readonly string[];
  /** The policy's outputs, by name, context units included. */
  readonly drives: readonly string[];
  /** The compiled muscle units, of which the id and four parameters are taken. */
  readonly muscles: readonly Pick<CompiledMuscleUnit, 'id' | 'parameters'>[];
  /** The cord under the brain, when whoever takes the fingerprint knows it. */
  readonly cord?: SpinalGains | undefined;
}

/**
 * A body, as a checkpoint records it.
 *
 * - `version`: which fields these are; see `BODY_FINGERPRINT_VERSION`.
 * - `profile`: the fidelity profile. Another one means other joints and other segments; the fit
 *   carries what it can by name, and a change here is the most common, and least alarming, one.
 * - `dtSeconds` and `controlDivisor`: the step and how often the policy ran. The same weights at
 *   another rate are another controller -- its rates and its held command mean other things.
 * - `senses`: how many, a hash of the names alone (which senses there are), a hash of the names
 *   with their meaning versions (the schema, which a sense fix moves and a rename moves too), and
 *   every sense whose meaning is not 1 with its version, so a change can be named sense by sense. The names are
 *   hashed sorted, because the fit is by name and the order they arrive in means nothing.
 * - `drives`: how many and a hash of their names, the same way.
 * - `muscles`: how many units and a hash of each one's id with its maximum isometric force,
 *   optimal fibre length, tendon slack length and pennation angle, to six significant figures:
 *   enough to see a data fix or another morphology, not so many that two JavaScript engines
 *   disagreeing in the last bit of a fitted tendon read as two bodies.
 * - `cord`: the spinal reflex gains under the brain, as numbers, when they were known.
 */
export interface BodyFingerprint {
  readonly version: number;
  readonly profile: string;
  readonly dtSeconds: number;
  readonly controlDivisor: number;
  readonly senses: {
    readonly count: number;
    readonly names: string;
    readonly schema: string;
    readonly meanings: Readonly<Record<string, number>>;
  };
  readonly drives: { readonly count: number; readonly names: string };
  readonly muscles: { readonly count: number; readonly hash: string };
  readonly cord?: SpinalGains;
}

/**
 * FNV-1a over the string's UTF-16 code units, as eight hex digits. Not cryptographic and not
 * meant to be: it only has to change when its input does, the same on every machine.
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** A number as the muscle hash reads it; see `BodyFingerprint.muscles`. */
function digits(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(6) : String(value);
}

/** Fingerprint a body. `meanings` is for a test that bumps a sense; the table is the default. */
export function bodyFingerprint(
  body: BodyDescription,
  meanings: Readonly<Record<string, number>> = SENSE_MEANINGS,
): BodyFingerprint {
  const senses = [...body.senses].sort();
  const changed: Record<string, number> = {};
  for (const name of senses) {
    const meaning = senseMeaning(name, meanings);
    if (meaning !== 1) changed[name] = meaning;
  }
  const muscles = body.muscles
    .map((u) => {
      const p = u.parameters;
      return [
        u.id,
        digits(p.maxIsometricForce),
        digits(p.optimalFiberLength),
        digits(p.tendonSlackLength),
        digits(p.pennationAngle),
      ].join(',');
    })
    .sort();
  return {
    version: BODY_FINGERPRINT_VERSION,
    profile: body.profile,
    dtSeconds: body.dtSeconds,
    controlDivisor: body.controlDivisor,
    senses: {
      count: senses.length,
      names: fnv1a(senses.join('\n')),
      schema: fnv1a(senses.map((name) => `${name}@${senseMeaning(name, meanings)}`).join('\n')),
      meanings: changed,
    },
    drives: { count: body.drives.length, names: fnv1a([...body.drives].sort().join('\n')) },
    muscles: { count: muscles.length, hash: fnv1a(muscles.join('\n')) },
    ...(body.cord ? { cord: { ...body.cord } } : {}),
  };
}

/** A number as a sentence says it: no more digits than it needs. */
function say(value: number): string {
  return String(Number(value.toPrecision(4)));
}

/** Two numbers that are the same to far better than anything here is measured. */
function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** The cord gains, in the order the Spine panel lists them. */
const CORD_FIELDS: readonly (keyof SpinalGains)[] = [
  'stretch',
  'velocity',
  'setPoint',
  'inhibition',
  'forceCeiling',
  'forceInhibition',
  'delaySeconds',
];

/**
 * How the cord a policy was trained over differs from the one under it now, as one line, or
 * nothing when they are the same. Separate from `compareBody` because the nerves do not know the
 * cord they sit on -- it is the spinal module's -- and the studio compares against its sliders.
 */
export function compareCord(saved: SpinalGains, current: SpinalGains): string | undefined {
  const changed = CORD_FIELDS.filter((f) => !same(saved[f], current[f])).map(
    (f) => `${f} ${say(saved[f])} then, ${say(current[f])} now`,
  );
  return changed.length ? `cord: ${changed.join('; ')}` : undefined;
}

/** Names past this many in one family are said as the family and a count. */
const NAMED_PER_FAMILY = 3;

/**
 * How the body a checkpoint was trained in differs from this one, a sentence a difference, in
 * the order a person would want them: the ones that change what the policy experiences most
 * first. Empty when they are the same body.
 *
 * `savedSenses`, the checkpoint's own input names, keeps a sense this body has and the checkpoint
 * never had from being reported as a change of meaning: it is new, and the fit already starts it
 * at zero. Without them, every sense whose version differs is reported.
 */
export function compareBody(
  saved: BodyFingerprint,
  current: BodyFingerprint,
  savedSenses?: readonly string[],
): string[] {
  if (saved.version !== current.version) {
    return [
      `recorded by body fingerprint version ${saved.version}, and this build reads version ` +
        `${current.version}, so the two cannot be compared field by field`,
    ];
  }
  const out: string[] = [];
  if (saved.profile !== current.profile) {
    out.push(`profile ${saved.profile} then, ${current.profile} now`);
  }
  if (!same(saved.dtSeconds, current.dtSeconds)) {
    out.push(`${say(1 / saved.dtSeconds)} steps a second then, ${say(1 / current.dtSeconds)} now`);
  }
  if (saved.controlDivisor !== current.controlDivisor) {
    out.push(
      `the policy ran every ${saved.controlDivisor} ticks then, every ${current.controlDivisor} now`,
    );
  }
  if (saved.senses.schema !== current.senses.schema) {
    // Meaning changes, named: every sense either side has a version other than 1 for.
    const had = savedSenses ? new Set(savedSenses) : undefined;
    const names = new Set([
      ...Object.keys(saved.senses.meanings),
      ...Object.keys(current.senses.meanings),
    ]);
    const byFamily = new Map<string, string[]>();
    for (const name of [...names].sort()) {
      if (had && !had.has(name)) continue;
      const then = saved.senses.meanings[name] ?? 1;
      const now = current.senses.meanings[name] ?? 1;
      if (then === now) continue;
      const family = senseFamily(name);
      const list = byFamily.get(family) ?? [];
      list.push(`${name} (${then} then, ${now} now)`);
      byFamily.set(family, list);
    }
    if (byFamily.size > 0) {
      const said = [...byFamily].map(([family, list]) =>
        list.length > NAMED_PER_FAMILY ? `every ${family} sense (${list.length})` : list.join(', '),
      );
      out.push(`sense meanings changed: ${said.join(', ')}`);
    }
    if (saved.senses.names !== current.senses.names) {
      out.push(
        saved.senses.count === current.senses.count
          ? `senses renamed (${current.senses.count} either way)`
          : `${saved.senses.count} senses then, ${current.senses.count} now`,
      );
    }
  }
  if (saved.drives.names !== current.drives.names) {
    out.push(
      saved.drives.count === current.drives.count
        ? `drives renamed (${current.drives.count} either way)`
        : `${saved.drives.count} drives then, ${current.drives.count} now`,
    );
  }
  if (saved.muscles.hash !== current.muscles.hash) {
    out.push(
      saved.muscles.count === current.muscles.count
        ? `muscle parameters differ (${current.muscles.count} units either way)`
        : `${saved.muscles.count} muscle units then, ${current.muscles.count} now`,
    );
  }
  if (saved.cord && current.cord) {
    const cord = compareCord(saved.cord, current.cord);
    if (cord) out.push(cord);
  }
  return out;
}

/**
 * Differences in a line short enough for a panel: the first `shown`, then how many more. The
 * whole list is for a tooltip.
 */
export function summariseDifferences(differences: readonly string[], shown = 2): string {
  const head = differences.slice(0, shown).join('; ');
  const rest = differences.length - shown;
  return rest > 0 ? `${head}; and ${rest} more` : head;
}
