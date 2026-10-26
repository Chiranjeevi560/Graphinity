// Collusion rings in who-picked-whom (docs/adr/0017-collusion-detection.md):
// accounts that give each other points by picking each other's answers.
//
// A ring can make its members act like anyone else: pick popular honest
// answers as camouflage, spread its picks thin, avoid picking back directly
// (A picks B, B picks C, C picks A). What it can't do is make honest people
// pick its members. So a ring is a set of accounts that receive most of
// their picks from inside the set. Found in three steps, all deterministic:
//
// 1. Closure: start with every account that was picked, then repeatedly
//    remove anyone who receives less than `minShare` of their picks (or
//    fewer than `minFromGroup`) from those still in. Removing only ever
//    lowers others' shares, so the result is the one largest such set.
//    Honest experts are picked by askers who are rarely picked themselves,
//    so honest experts fall out early.
// 2. Strongly connected parts of what is left: accounts that can reach each
//    other by picks. A ring's camouflage props up the popular accounts it
//    picks, but those never pick the ring back, so they land in parts of
//    their own.
// 3. Lift: how many times more a part's members picked each other than
//    their overall activity predicts. A part is a ring when it has at least
//    `minSize` accounts, `minInside` picks among them and lift `minLift`.
//    Measured (scripts/benchmark-fraud.mjs): honest parts stay under 7.
//
// What this does not find, by design: several new accounts all picking one
// beneficiary (sockpuppets) look exactly like a niche expert's askers in the
// pick graph. Those are shown to moderators by shared networks
// (routes/moderation.ts) instead.

export interface PickEdge<Id> {
  source: Id;
  target: Id;
  /** Times `source` picked or marked `target`'s answers. */
  count?: number;
}

export interface Ring<Id> {
  members: Id[];
  /** Picks among the members. */
  inside: number;
  /** Picks among them their overall activity predicts. */
  expected: number;
  lift: number;
}

export interface RingOptions {
  minShare?: number;
  minFromGroup?: number;
  minSize?: number;
  minInside?: number;
  minLift?: number;
}

export const RING_DEFAULTS = { minShare: 0.5, minFromGroup: 2, minSize: 3, minInside: 6, minLift: 20 } as const;

/** Rings among `edges`, the most extreme (highest lift) first. Self-picks are ignored. */
export function findRings<Id extends string | number>(
  edges: readonly PickEdge<Id>[],
  options: RingOptions = {},
): Ring<Id>[] {
  const o = { ...RING_DEFAULTS, ...options };
  const picks = edges.filter(e => e.source !== e.target);
  const rings: Ring<Id>[] = [];
  for (const part of stronglyConnected(closure(picks, o.minShare, o.minFromGroup), picks)) {
    if (part.length < o.minSize) continue;
    const l = lift(part, picks);
    if (l.inside >= o.minInside && l.lift >= o.minLift) rings.push({ members: sortIds(part), ...l });
  }
  return rings.sort((a, b) => b.lift - a.lift || compareIds(a.members[0], b.members[0]));
}

/** The largest set of accounts each receiving at least `minShare` of their picks from inside it. */
export function closure<Id>(picks: readonly PickEdge<Id>[], minShare: number, minFromGroup: number): Set<Id> {
  const received = new Map<Id, number>();
  const fromGroup = new Map<Id, number>();
  const given = new Map<Id, PickEdge<Id>[]>();
  for (const e of picks) {
    const c = e.count ?? 1;
    received.set(e.target, (received.get(e.target) ?? 0) + c);
    const list = given.get(e.source) ?? [];
    list.push(e);
    given.set(e.source, list);
  }
  const group = new Set(received.keys());
  for (const e of picks)
    if (group.has(e.source)) fromGroup.set(e.target, (fromGroup.get(e.target) ?? 0) + (e.count ?? 1));
  const holds = (id: Id) => {
    const inside = fromGroup.get(id) ?? 0;
    return inside >= minFromGroup && inside >= minShare * (received.get(id) ?? 0);
  };
  const leaving = [...group].filter(id => !holds(id));
  for (let id = leaving.pop(); id !== undefined; id = leaving.pop()) {
    if (!group.delete(id)) continue;
    for (const e of given.get(id) ?? []) {
      if (!group.has(e.target)) continue;
      fromGroup.set(e.target, (fromGroup.get(e.target) ?? 0) - (e.count ?? 1));
      if (!holds(e.target)) leaving.push(e.target);
    }
  }
  return group;
}

/** Strongly connected parts of the picks among `group` (Tarjan, without recursion). */
export function stronglyConnected<Id>(group: ReadonlySet<Id>, picks: readonly PickEdge<Id>[]): Id[][] {
  const next = new Map<Id, Id[]>();
  for (const e of picks) {
    if (!group.has(e.source) || !group.has(e.target)) continue;
    const list = next.get(e.source) ?? [];
    list.push(e.target);
    next.set(e.source, list);
  }
  const index = new Map<Id, number>();
  const low = new Map<Id, number>();
  const onStack = new Set<Id>();
  const stack: Id[] = [];
  const parts: Id[][] = [];
  let counter = 0;
  const visit = (v: Id) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
  };
  for (const root of group) {
    if (index.has(root)) continue;
    visit(root);
    const work: Array<{ v: Id; i: number }> = [{ v: root, i: 0 }];
    while (work.length) {
      const top = work[work.length - 1];
      if (!top) break;
      const out = next.get(top.v) ?? [];
      const w = out[top.i];
      if (w !== undefined) {
        top.i++;
        if (!index.has(w)) {
          visit(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v) ?? 0, index.get(w) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v) ?? 0, low.get(top.v) ?? 0));
      if (low.get(top.v) === index.get(top.v)) {
        const part: Id[] = [];
        for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
          onStack.delete(x);
          part.push(x);
          if (x === top.v) break;
        }
        parts.push(part);
      }
    }
  }
  return parts;
}

/**
 * How many times more `members` picked each other than their overall
 * activity predicts: picks among them / (their picks given x their picks
 * received / all picks). A ratio, not a p-value: every part here was chosen
 * for being closed, so a significance test that ignores the choosing would
 * call even honest parts astronomically unlikely.
 */
export function lift<Id>(
  members: readonly Id[],
  picks: readonly PickEdge<Id>[],
): { inside: number; expected: number; lift: number } {
  const set = new Set(members);
  let total = 0;
  let given = 0;
  let received = 0;
  let inside = 0;
  for (const e of picks) {
    const c = e.count ?? 1;
    total += c;
    if (set.has(e.source)) given += c;
    if (set.has(e.target)) received += c;
    if (set.has(e.source) && set.has(e.target)) inside += c;
  }
  const expected = total ? (given * received) / total : 0;
  return { inside, expected, lift: expected > 0 ? inside / expected : 0 };
}

const compareIds = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const sortIds = <Id>(ids: readonly Id[]): Id[] => [...ids].sort(compareIds);
