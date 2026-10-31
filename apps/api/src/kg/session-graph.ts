// What people look at next within one visit (master charter §4.2): first- and
// second-order Markov transitions with decay, over topics and entities. Only counts
// of A → B are kept, pooled per topic, never who or which visit, so "next most
// needed" needs no surveillance between sessions. Backs off from second to first
// order when a context is rare; benchmarked against first-order alone.

export interface TransitionTable {
  first: Map<string, Map<string, number>>;
  second: Map<string, Map<string, number>>;
}

export const emptyTransitions = (): TransitionTable => ({ first: new Map(), second: new Map() });

const bump = (table: Map<string, Map<string, number>>, from: string, to: string, by: number) => {
  const row = table.get(from) ?? new Map<string, number>();
  row.set(to, (row.get(to) ?? 0) + by);
  table.set(from, row);
};

export function observeSession(t: TransitionTable, session: readonly string[], weight = 1): void {
  for (let i = 1; i < session.length; i++) {
    const from = session[i - 1] ?? '';
    const to = session[i] ?? '';
    if (from === to) continue;
    bump(t.first, from, to, weight);
    if (i >= 2) bump(t.second, `${session[i - 2] ?? ''}\u0000${from}`, to, weight);
  }
}

/** Multiplies every count by `factor`, dropping those that faded away. */
export function decayTransitions(t: TransitionTable, factor: number, floor = 0.01): void {
  for (const table of [t.first, t.second])
    for (const [from, row] of table) {
      for (const [to, c] of row) {
        const next = c * factor;
        if (next < floor) row.delete(to);
        else row.set(to, next);
      }
      if (row.size === 0) table.delete(from);
    }
}

const SECOND_ORDER_MIN = 5;

/** The likeliest next items after `previous → current`, excluding what was just seen. */
export function nextItems(
  t: TransitionTable,
  current: string,
  previous: string | null,
  k = 5,
): Array<{ item: string; probability: number }> {
  const second = previous === null ? undefined : t.second.get(`${previous}\u0000${current}`);
  const secondTotal = second ? [...second.values()].reduce((a, b) => a + b, 0) : 0;
  const row = second && secondTotal >= SECOND_ORDER_MIN ? second : t.first.get(current);
  if (!row) return [];
  const total = [...row.values()].reduce((a, b) => a + b, 0);
  return [...row]
    .filter(([item]) => item !== previous)
    .map(([item, c]) => ({ item, probability: c / total }))
    .sort((a, b) => b.probability - a.probability || (a.item < b.item ? -1 : 1))
    .slice(0, k);
}
