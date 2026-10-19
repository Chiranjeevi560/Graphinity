// The graph in words: the caption under every graph, and what screen
// readers get instead of the picture.
import type { GraphData } from './graph-layout.ts';

const n = (count: number, one: string, many: string) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** "312 people across 14 fields · 9 questions and 26 answers in the last day". */
export function graphCaption(data: Pick<GraphData, 'members' | 'fields' | 'activity'>): string {
  if (data.members === 0) return 'Nobody has joined yet. The first people to join start the graph.';
  const fields = data.fields.filter(f => f.members > 0).length;
  const parts = [`${n(data.members, 'person', 'people')} across ${n(fields, 'field', 'fields')}`];
  const { questions, answers } = data.activity.lastDay;
  if (questions + answers > 0) parts.push(`${n(questions, 'question', 'questions')} and ${n(answers, 'answer', 'answers')} in the last day`);
  return parts.join(' · ');
}

/** What the asker reads about where their question went. */
export function routingLine(r: { asked: number | null; inCountry: number | null }, field: string, country: string | null): string {
  const who = r.asked === null ? 'a few people' : n(r.asked, 'person', 'people');
  const local = r.inCountry !== null && country ? ` · ${r.inCountry.toLocaleString('en')} in ${country}` : '';
  return `Sent to ${who} who know ${field}${local}`;
}
