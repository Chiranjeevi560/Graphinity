// The graph in words: the caption under every graph, and what screen
// readers get instead of the picture.
import type { GraphData, GraphField } from './graph-layout.ts';

const n = (count: number, one: string, many: string) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** "312 people across 14 fields · 9 questions and 26 answers in the last day". */
export function graphCaption(data: Pick<GraphData, 'members' | 'fields' | 'activity'>): string {
  if (data.members === 0) return 'Nobody has joined yet. The first people to join start the graph.';
  const fields = data.fields.filter(f => f.members > 0).length;
  const parts = [`${n(data.members, 'person', 'people')} across ${n(fields, 'field', 'fields')}`];
  const { questions, answers } = data.activity.lastDay;
  if (questions + answers > 0)
    parts.push(`${n(questions, 'question', 'questions')} and ${n(answers, 'answer', 'answers')} in the last day`);
  return parts.join(' · ');
}

/** What the asker reads about where their question went. */
export function routingLine(
  r: { asked: number | null; inCountry: number | null },
  field: string,
  country: string | null,
): string {
  const who = r.asked === null ? 'a few people' : n(r.asked, 'person', 'people');
  const local = r.inCountry !== null && country ? ` · ${r.inCountry.toLocaleString('en')} in ${country}` : '';
  return `Sent to ${who} who know ${field}${local}`;
}

/** Under 5, an exact count set against public profiles could point at who. */
const few = (count: number, one: string, many: string) => (count < 5 ? `a few ${many}` : n(count, one, many));

/** A field as a keyboard or screen-reader stop: "Imports & Customs, 40 people". */
export function fieldLabel(field: GraphField): string {
  return `${field.name}, ${few(field.members, 'person', 'people')}`;
}

/** The other fields a field's people also know, most shared first ("a few", null, last). */
export function neighbours(
  data: Pick<GraphData, 'fields' | 'links'>,
  index: number,
): Array<{ index: number; shared: number | null }> {
  return (data.links ?? [])
    .filter(l => (l.a === index || l.b === index) && data.fields[l.a === index ? l.b : l.a])
    .map(l => ({ index: l.a === index ? l.b : l.a, shared: l.shared }))
    .sort((x, y) => (y.shared ?? 0) - (x.shared ?? 0) || x.index - y.index);
}

/** What opening a field says: who knows it, and where else they reach. */
export function fieldNeighbourhood(data: Pick<GraphData, 'fields' | 'links'>, index: number): string {
  const field = data.fields[index];
  if (!field) return '';
  const who = few(field.members, 'person', 'people');
  const opening = `${who.charAt(0).toUpperCase()}${who.slice(1)} know ${field.name}.`;
  const near = neighbours(data, index)
    .slice(0, 3)
    .map(
      ({ index: i, shared }) =>
        `${shared === null || shared < 5 ? 'a few' : shared.toLocaleString('en')} also know ${data.fields[i]?.name ?? ''}`,
    );
  if (near.length === 0) return `${opening} None of them list another field yet.`;
  const list = near.length === 1 ? near[0] : `${near.slice(0, -1).join(', ')}, and ${near[near.length - 1] ?? ''}`;
  return `${opening} ${(list ?? '').charAt(0).toUpperCase()}${(list ?? '').slice(1)}.`;
}
