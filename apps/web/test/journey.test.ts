import { describe, expect, it } from 'vitest';
import { journeyStore } from '../src/lib/journey.ts';

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  };
}

describe('a journey between topics', () => {
  it('has no step for the first topic or a repeat, then says where it came from', () => {
    const j = journeyStore(memory);
    const shared = memory();
    const store = journeyStore(() => shared);
    expect(j.note('travel')).toBeNull();
    expect(store.note('travel')).toBeNull();
    expect(store.note('travel')).toBeNull();
    expect(store.note('visas')).toEqual({ from: 'travel', to: 'visas' });
    expect(store.note('tax')).toEqual({ from: 'visas', to: 'tax', previous: 'travel' });
    // Back to where it was two steps ago: no "previous" that equals where it's going.
    expect(store.note('visas')).toEqual({ from: 'tax', to: 'visas' });
  });

  it('forgets on request, and survives storage that is blocked or holds junk', () => {
    const shared = memory();
    const store = journeyStore(() => shared);
    store.note('travel');
    store.forget();
    expect(store.note('visas')).toBeNull();
    shared.setItem('graphinity.journey', 'not json');
    expect(store.note('tax')).toBeNull();
    const blocked = journeyStore(() => {
      throw new Error('blocked');
    });
    expect(blocked.note('travel')).toBeNull();
    expect(() => {
      blocked.forget();
    }).not.toThrow();
  });
});
