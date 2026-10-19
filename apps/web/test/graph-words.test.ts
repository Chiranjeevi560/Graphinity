import { describe, expect, it } from 'vitest';
import { must } from './must.ts';
import { fieldLabel, fieldNeighbourhood, graphCaption, neighbours, routingLine } from '../src/lib/graph-words.ts';

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

describe('a field, from the keyboard', () => {
  const named = (name: string, members: number) => ({ slug: name.toLowerCase(), name, members });
  // 0 Customs, 1 Travel, 2 Visas, 3 Work, 4 Nobody here.
  const fields = [named('Customs', 40), named('Travel', 20), named('Visas', 9), named('Work', 3), named('Empty', 0)];
  // As the server sends them: exact, and null ("a few") under 5.
  const links = [{ a: 0, b: 2, shared: null }, { a: 0, b: 1, shared: 12 }, { a: 0, b: 3, shared: null }];
  const data = { fields, links };

  it('names the field and how many know it, "a few" under 5', () => {
    expect(fieldLabel(must(fields[0]))).toBe('Customs, 40 people');
    expect(fieldLabel(must(fields[3]))).toBe('Work, a few people');
  });

  it('lists the fields its people also know, most shared first', () => {
    expect(neighbours(data, 0)).toEqual([{ index: 1, shared: 12 }, { index: 2, shared: null }, { index: 3, shared: null }]);
    expect(neighbours(data, 1)).toEqual([{ index: 0, shared: 12 }]);
    expect(neighbours(data, 4)).toEqual([]);
    expect(neighbours({ fields }, 0)).toEqual([]);
  });

  it('says the neighbourhood in words, never an exact number under 5, even if one slipped through', () => {
    expect(fieldNeighbourhood(data, 0)).toBe('40 people know Customs. 12 also know Travel, a few also know Visas, and a few also know Work.');
    expect(fieldNeighbourhood(data, 1)).toBe('20 people know Travel. 12 also know Customs.');
    expect(fieldNeighbourhood({ fields, links: [{ a: 0, b: 1, shared: 3 }] }, 1)).toBe('20 people know Travel. A few also know Customs.');
    expect(fieldNeighbourhood({ fields: [named('Solo', 2)], links: [] }, 0)).toBe('A few people know Solo. None of them list another field yet.');
  });
});
