/**
 * A chosen checkpoint, found again when the list it was chosen from is replaced by another.
 *
 * The dashboard names a checkpoint by its path in the data folder and the studio on its own names
 * it by its bare name, so the same `stand` is `policies/stand.json` one poll and `stand` the next
 * whenever the server starts or stops. The selection used to follow the id, which meant it
 * silently went back to None every time -- and a Hand over pressed after that did nothing.
 */

import { describe, expect, it } from 'vitest';
import { checkpointKey, checkpointStem, reselect } from './checkpointKey.js';

const local = [{ id: 'stand' }, { id: 'balance' }];
const served = [
  { id: 'policies/stand.json' },
  { id: 'runs/stand-centre.json' },
  { id: 'policies/balance.json' },
];

describe('checkpointKey', () => {
  it('gives a policy the same key under the server and without it', () => {
    expect(checkpointKey('stand')).toBe(checkpointKey('policies/stand.json'));
    expect(checkpointKey('stand')).toBe('policy:stand');
    expect(checkpointStem('policies/stand.json')).toBe('stand');
  });

  it('keeps a search centre apart from the policy it is the centre of', () => {
    expect(checkpointKey('runs/stand-centre.json')).toBe('centre:stand-centre');
    expect(checkpointKey('runs/stand-centre.json')).not.toBe(checkpointKey('stand'));
  });
});

describe('reselect', () => {
  it('finds the same checkpoint across a server starting and stopping', () => {
    expect(reselect(local, 'policies/stand.json', checkpointKey('policies/stand.json'))).toBe(
      'stand',
    );
    expect(reselect(served, 'stand', checkpointKey('stand'))).toBe('policies/stand.json');
  });

  it('has no local match for a search centre, which only a server lists', () => {
    expect(reselect(local, 'runs/stand-centre.json', checkpointKey('runs/stand-centre.json'))).toBe(
      '',
    );
  });

  it('prefers the exact id to one that only shares its key', () => {
    const both = [{ id: 'policies/stand.json' }, { id: 'stand' }];
    expect(reselect(both, 'stand', checkpointKey('stand'))).toBe('stand');
  });

  it('gives nothing for a checkpoint it has never heard of, or for no choice at all', () => {
    expect(reselect(served, 'walk', checkpointKey('walk'))).toBe('');
    expect(reselect(served, '', '')).toBe('');
  });
});
