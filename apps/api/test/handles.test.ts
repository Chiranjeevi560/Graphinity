import { describe, expect, it } from 'vitest';
import { handleProblem, normalizeHandle } from '../src/handles.ts';

// Shared with profile.integration.test.ts, which runs the same examples
// through the database's rule to prove the two agree.
export const handleExamples: Array<[string, ReturnType<typeof handleProblem>]> = [
  ['chiru', null],
  ['chiru.k', null],
  ['chiru_k99', null],
  ['a1b', null],
  ['x'.repeat(24), null],
  ['ab', 'length'],
  ['x'.repeat(25), 'length'],
  ['chiru k', 'characters'],
  ['chiru-k', 'characters'],
  ['chirü', 'characters'],
  ['.chiru', 'edges'],
  ['chiru.', 'edges'],
  ['_chiru', 'edges'],
  ['chi..ru', 'dots'],
  ['12345', 'digits'],
  ['admin', 'reserved'],
  ['support', 'reserved'],
  ['graphinity', 'reserved'],
  ['graphinity_team', 'reserved'],
];

describe('handleProblem', () => {
  it.each(handleExamples)('%s → %s', (handle, problem) => {
    expect(handleProblem(handle)).toBe(problem);
  });
});

describe('normalizeHandle', () => {
  it('trims and lowercases', () => {
    expect(normalizeHandle('  Chiru.K ')).toBe('chiru.k');
  });
});
