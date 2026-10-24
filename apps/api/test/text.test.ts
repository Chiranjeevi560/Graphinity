import { describe, expect, it } from 'vitest';
import { cleanBody, cleanLine, prefixQuery, textProblem } from '../src/text.ts';

describe('tidying what people type', () => {
  it('makes a title one line with single spaces', () => {
    expect(cleanLine('  How do I\timport   a watch\ninto the UAE? ')).toBe('How do I import a watch into the UAE?');
  });

  it('keeps paragraphs, turning Windows line breaks and tabs into plain ones', () => {
    expect(cleanBody('\r\nFirst line\r\nSecond\tline\n\n')).toBe('First line\nSecond  line');
  });

  it('counts characters as people do, so an emoji is one, not two', () => {
    expect(textProblem('😀'.repeat(20), 20, 20)).toBeNull();
    expect(textProblem('😀'.repeat(21), 20, 20)).toBe('too_long');
  });

  it('refuses invisible control characters but allows line breaks', () => {
    expect(textProblem('fine\nline breaks are fine here', 5, 100)).toBeNull();
    expect(textProblem('a bell\u0007 hidden inside', 5, 100)).toBe('invalid_characters');
    expect(textProblem('delete\u007F char', 5, 100)).toBe('invalid_characters');
  });

  it('refuses characters that make text display as something else, but keeps right-to-left marks', () => {
    // Direction overrides and isolates: what you see isn't the stored order.
    for (const mark of [
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u202E',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
      '\u0080',
      '\u0085',
      '\u009F',
    ]) {
      expect(textProblem(`price ${mark}reversed here`, 5, 100), mark.codePointAt(0)?.toString(16)).toBe(
        'invalid_characters',
      );
    }
    expect(textProblem('שלום \u200Fעולם and \u200Emore', 5, 100)).toBeNull();
    expect(textProblem('مرحبا \u061C بالعالم', 5, 100)).toBeNull();
    expect(textProblem('café, naïve, ¡hola! ½', 5, 100)).toBeNull();
  });
});

describe('matching while typing', () => {
  it('matches every word, including the one still being typed', () => {
    expect(prefixQuery('Importing a watch to Dub')).toBe('importing:* | watch:* | to:* | dub:*');
  });

  it('can ask for all of the words instead of any of them', () => {
    expect(prefixQuery('Importing a watch to Dub', 'all')).toBe('importing:* & watch:* & to:* & dub:*');
    expect(prefixQuery('visa & work:* | (permit)', 'all')).toBe('visa:* & work:* & permit:*');
    // Indian scripts write vowel signs as combining marks: they stay inside the word.
    expect(prefixQuery('తెలుగులో కస్టమ్స్ డ్యూటీ ఎంత?')).toBe('తెలుగులో:* | కస్టమ్స్:* | డ్యూటీ:* | ఎంత:*');
    expect(prefixQuery('हिंदी में कस्टम ड्यूटी', 'all')).toBe('हिंदी:* & में:* & कस्टम:* & ड्यूटी:*');
  });

  it('lets nothing through that could change the query', () => {
    expect(prefixQuery("a & b | !c :* <-> 'x' (y)")).toBeNull();
    expect(prefixQuery('visa & work:* | (permit)')).toBe('visa:* | work:* | permit:*');
  });

  it('ignores repeats and keeps the query short', () => {
    expect(prefixQuery('tax tax tax')).toBe('tax:*');
    expect(prefixQuery(Array.from({ length: 30 }, (_, i) => `word${String(i)}`).join(' '))?.split(' | ')).toHaveLength(
      12,
    );
  });

  it('keeps letters from any language', () => {
    expect(prefixQuery('Zürich São Paulo')).toBe('zürich:* | são:* | paulo:*');
  });
});
