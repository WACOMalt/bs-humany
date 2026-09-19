import { describe, expect, it } from 'vitest';
import { createMemory } from './memory.js';

function fakeStorage(): Storage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('the page memory', () => {
  it('remembers under its own prefix and forgets nothing it was not told', () => {
    const store = fakeStorage();
    const memory = createMemory(store);
    expect(memory.get('tab')).toBeUndefined();
    memory.set('tab', 'brain');
    expect(memory.get('tab')).toBe('brain');
    expect([...store.map.keys()]).toEqual(['bs-humany.studio.tab']);
  });

  it('works without a store, and with one that throws', () => {
    const none = createMemory(undefined);
    none.set('tab', 'brain');
    expect(none.get('tab')).toBeUndefined();
    const broken = createMemory({
      ...fakeStorage(),
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    broken.set('tab', 'brain');
    expect(broken.get('tab')).toBeUndefined();
  });
});
