import { describe, expect, it } from 'vitest';
import { charCount, questionPath, slugify, timeAgo } from '../src/lib/questions.ts';

describe('question addresses', () => {
  it('turns a title into a readable address part', () => {
    expect(slugify('How do I import a watch into the UAE?')).toBe('how-do-i-import-a-watch-into-the-uae');
    expect(slugify('Café visas in São Paulo — 2026!')).toBe('cafe-visas-in-sao-paulo-2026');
    expect(questionPath({ id: '42', title: 'Moving to Dubai?' })).toBe('/q/42/moving-to-dubai');
  });

  it('cuts long titles at a word, and copes with titles that have no Latin letters', () => {
    const slug = slugify('word '.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
    expect(questionPath({ id: '7', title: '日本でビザを更新するには?' })).toBe('/q/7');
  });
});

describe('when things happened', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  it('reads like a person would say it', () => {
    expect(timeAgo('2026-10-18T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-18T11:55:00Z', now)).toBe('5 minutes ago');
    expect(timeAgo('2026-10-18T09:00:00Z', now)).toBe('3 hours ago');
    expect(timeAgo('2026-10-17T12:00:00Z', now)).toBe('yesterday');
    expect(timeAgo('2026-08-01T12:00:00Z', now)).toBe('Aug 1, 2026');
  });
});

describe('counting characters', () => {
  it('counts an emoji as one, like the server', () => {
    expect(charCount('😀😀')).toBe(2);
  });
});

describe('amounts and agreement in words', () => {
  it('writes amounts the way their currency does', async () => {
    const { formatAmount, formatRange } = await import('../src/lib/questions.ts');
    expect(formatAmount(14_000_000, 'INR')).toBe('₹1,40,000');
    expect(formatAmount(120_050, 'USD')).toBe('$1,200.50');
    expect(formatRange(9_200_000, 9_800_000, 'INR')).toBe('₹92,000–₹98,000');
    expect(formatRange(8_000_000, 8_000_000, 'INR')).toBe('₹80,000');
    expect(formatAmount(500, 'XXX!')).toBe('XXX! 5');
  });

  it('says how far people agree in plain words', async () => {
    const { agreementWords } = await import('../src/lib/questions.ts');
    expect(agreementWords(0.85)).toBe('Most people agree');
    expect(agreementWords(0.5)).toBe('People partly agree');
    expect(agreementWords(0.1)).toBe('People’s experiences differ');
  });
});
