import { describe, expect, it } from 'vitest';
import { graphCaption, routingLine } from '../src/lib/graph-words.ts';

const field = (members: number) => ({ slug: 's', name: 'S', members });
const quiet = { lastDay: { questions: 0, answers: 0 }, recent: [] };

describe('the graph in words', () => {
  it('counts people once and only fields that have someone', () => {
    expect(graphCaption({ members: 1312, fields: [field(900), field(600), field(0)], activity: quiet })).toBe('1,312 people across 2 fields');
  });

  it('adds the last day’s activity when there was some, in the singular when it’s one', () => {
    expect(graphCaption({ members: 1, fields: [field(1)], activity: { lastDay: { questions: 1, answers: 0 }, recent: [] } }))
      .toBe('1 person across 1 field · 1 question and 0 answers in the last day');
  });

  it('says plainly when nobody has joined, instead of drawing an empty promise', () => {
    expect(graphCaption({ members: 0, fields: [field(0)], activity: quiet })).toBe('Nobody has joined yet. The first people to join start the graph.');
  });
});

describe('where a question went', () => {
  it('gives numbers, and the country only when it is known', () => {
    expect(routingLine({ asked: 10, inCountry: 6 }, 'Imports & Customs', 'India')).toBe('Sent to 10 people who know Imports & Customs · 6 in India');
    expect(routingLine({ asked: 10, inCountry: null }, 'Travel', 'India')).toBe('Sent to 10 people who know Travel');
  });

  it('says "a few" when the number is small enough to point at who', () => {
    expect(routingLine({ asked: null, inCountry: null }, 'Watches', null)).toBe('Sent to a few people who know Watches');
  });
});
