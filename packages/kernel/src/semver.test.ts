import { describe, expect, it } from 'vitest';
import { parseVersion, satisfies } from './semver.js';

describe('semver subset', () => {
  it('parses and rejects malformed versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(() => parseVersion('1.2')).toThrow(/not a semver version/);
  });

  it('matches exact, caret, tilde, gte and star', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
    expect(satisfies('1.9.0', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('3.0.0', '>=1.2.3')).toBe(true);
    expect(satisfies('1.2.2', '>=1.2.3')).toBe(false);
    expect(satisfies('0.0.1', '*')).toBe(true);
  });

  it('treats 0.x carets as minor-locked, the way npm does', () => {
    expect(satisfies('0.1.7', '^0.1.2')).toBe(true);
    expect(satisfies('0.2.0', '^0.1.2')).toBe(false);
  });

  it('rejects an unsupported range rather than guessing', () => {
    expect(() => satisfies('1.0.0', '1.x')).toThrow(/Unsupported version range/);
  });
});
