// Which things go together (master charter §8): FP-Growth (Han et al., SIGMOD 2000)
// mines frequent sets without Apriori's candidate generation, and rules are scored
// with smoothed lift and PMI, because raw confidence just rewards popular items.
// Input is a set of topics or products per session, never a person.

interface Node {
  item: string;
  count: number;
  parent: Node | null;
  children: Map<string, Node>;
}

function grow(baskets: ReadonlyArray<{ items: readonly string[]; count: number }>, minSupport: number) {
  const totals = new Map<string, number>();
  for (const b of baskets) for (const i of new Set(b.items)) totals.set(i, (totals.get(i) ?? 0) + b.count);
  const order = [...totals].filter(([, c]) => c >= minSupport).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const rank = new Map(order.map(([i], k) => [i, k]));
  const root: Node = { item: '', count: 0, parent: null, children: new Map() };
  const links = new Map<string, Node[]>();
  for (const b of baskets) {
    const items = [...new Set(b.items)]
      .filter(i => rank.has(i))
      .sort((x, y) => (rank.get(x) ?? 0) - (rank.get(y) ?? 0));
    let at = root;
    for (const i of items) {
      let next = at.children.get(i);
      if (!next) {
        next = { item: i, count: 0, parent: at, children: new Map() };
        at.children.set(i, next);
        links.set(i, [...(links.get(i) ?? []), next]);
      }
      next.count += b.count;
      at = next;
    }
  }
  return { order, links };
}

export interface ItemSet {
  items: string[];
  support: number;
}

/** Every set with at least `minSupport` baskets, up to `maxSize` items. */
export function fpGrowth(
  baskets: ReadonlyArray<{ items: readonly string[]; count?: number }>,
  minSupport: number,
  maxSize = 3,
): ItemSet[] {
  const out: ItemSet[] = [];
  const mine = (data: ReadonlyArray<{ items: readonly string[]; count: number }>, suffix: readonly string[]) => {
    const { order, links } = grow(data, minSupport);
    for (const [item, support] of [...order].reverse()) {
      const set = [item, ...suffix];
      out.push({ items: [...set].sort(), support });
      if (set.length >= maxSize) continue;
      const conditional: Array<{ items: string[]; count: number }> = [];
      for (const node of links.get(item) ?? []) {
        const path: string[] = [];
        for (let p = node.parent; p?.parent; p = p.parent) path.push(p.item);
        if (path.length) conditional.push({ items: path, count: node.count });
      }
      if (conditional.length) mine(conditional, set);
    }
  };
  mine(
    baskets.map(b => ({ items: b.items, count: b.count ?? 1 })),
    [],
  );
  return out;
}

export interface Rule {
  from: string;
  to: string;
  support: number;
  confidence: number;
  lift: number;
  pmi: number;
}

/** Pairwise rules A ⇒ B. ε pulls rare pairs' lift toward 1, so one lucky basket can't top the list. */
export function associationRules(sets: readonly ItemSet[], total: number, epsilon = 1e-3, minLift = 1): Rule[] {
  const single = new Map<string, number>();
  for (const s of sets) if (s.items.length === 1 && s.items[0]) single.set(s.items[0], s.support);
  const rules: Rule[] = [];
  for (const s of sets) {
    if (s.items.length !== 2) continue;
    const [a = '', b = ''] = s.items;
    const pa = (single.get(a) ?? 0) / total;
    const pb = (single.get(b) ?? 0) / total;
    const pab = s.support / total;
    const lift = (pab + epsilon) / ((pa + epsilon) * (pb + epsilon));
    if (lift < minLift) continue;
    const pmi = Math.log(lift);
    rules.push({ from: a, to: b, support: pab, confidence: pab / Math.max(pa, 1e-12), lift, pmi });
    rules.push({ from: b, to: a, support: pab, confidence: pab / Math.max(pb, 1e-12), lift, pmi });
  }
  return rules.sort((x, y) => y.lift - x.lift || y.support - x.support);
}
