import { describe, expect, it } from 'vitest';
import { draftStore } from '../src/lib/drafts.ts';

function memory() {
  const m = new Map<string, string>();
  return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } } };
}
const isText = (v: unknown): v is { body: string } => typeof v === 'object' && v !== null && typeof (v as { body?: unknown }).body === 'string';

describe('drafts', () => {
  it('keep what was typed across a reload, and forget it once posted', () => {
    const { storage } = memory();
    const before = draftStore(storage);
    before.save('answer.7', { body: 'Paid ₹95,000' });
    const after = draftStore(storage); // a reload: a new page, the same tab
    expect(after.load('answer.7', isText)).toEqual({ body: 'Paid ₹95,000' });
    after.save('answer.7', null);
    expect(after.load('answer.7', isText)).toBeNull();
  });

  it('keep each draft apart', () => {
    const { storage } = memory();
    const d = draftStore(storage);
    d.save('answer.1', { body: 'one' });
    d.save('answer.2', { body: 'two' });
    expect(d.load('answer.1', isText)).toEqual({ body: 'one' });
  });

  it('don’t store an empty draft', () => {
    const { m, storage } = memory();
    draftStore(storage).save('ask', { body: '   ' }, v => v.body.trim() === '');
    expect(m.size).toBe(0);
  });

  it('distrust what they read back: anything the wrong shape is dropped', () => {
    const { m, storage } = memory();
    m.set('graphinity.draft.answer.3', '{"body":42}');
    m.set('graphinity.draft.answer.4', 'not json');
    const d = draftStore(storage);
    expect(d.load('answer.3', isText)).toBeNull();
    expect(d.load('answer.4', isText)).toBeNull();
    expect(m.has('graphinity.draft.answer.3')).toBe(false);
  });

  it('are all forgotten on signing out, and nothing else is touched', () => {
    const { m, storage } = memory();
    m.set('graphinity.refresh', 'kept by sign-in, not ours');
    const d = draftStore(storage);
    d.save('ask', { body: 'a' });
    d.save('answer.9', { body: 'b' });
    d.clear();
    expect([...m.keys()]).toEqual(['graphinity.refresh']);
  });

  it('still work for the page when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); }, key: () => { throw new Error('blocked'); }, get length(): number { throw new Error('blocked'); } };
    const d = draftStore(blocked);
    d.save('ask', { body: 'typed' });
    expect(d.load('ask', isText)).toEqual({ body: 'typed' });
    d.clear();
    expect(d.load('ask', isText)).toBeNull();
  });
});
