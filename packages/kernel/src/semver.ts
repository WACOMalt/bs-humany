/**
 * The subset of semver range matching the kernel needs.
 *
 * Manifests declare the version range of each channel and module they depend on. Checking it is
 * what turns "this module was written against body.pose 1.x" from a comment into a guarantee.
 * Written here rather than adding a dependency (CONTRIBUTING rule 1): four range forms cover
 * every manifest in the project, and a full semver library is fifty times the code.
 *
 * Supported: `1.2.3` (exact), `^1.2.3` (same major; for 0.x, same minor), `~1.2.3` (same
 * major.minor), `>=1.2.3`, and `*`.
 */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseVersion(text: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!m) throw new Error(`'${text}' is not a semver version (expected major.minor.patch).`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True when `version` satisfies `range`. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const r = range.trim();
  if (r === '*' || r === '') return true;

  const m = /^(\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(r);
  if (!m)
    throw new Error(
      `Unsupported version range '${range}'. Use x.y.z, ^x.y.z, ~x.y.z, >=x.y.z or *.`,
    );
  const op = m[1] ?? '';
  const base = parseVersion(m[2] ?? '0.0.0');

  if (compare(v, base) < 0) return false;
  switch (op) {
    case '':
      return compare(v, base) === 0;
    case '>=':
      return true;
    case '~':
      return v.major === base.major && v.minor === base.minor;
    case '^':
      return base.major === 0 ? v.major === 0 && v.minor === base.minor : v.major === base.major;
    default:
      return false;
  }
}
