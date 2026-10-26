// Multi-touch attribution (docs/adr/0022-advertising-platform.md part 6b):
// for each conversion, how much credit each campaign on the path to it
// earns. Pure and deterministic. The rule-based models split one
// conversion's credit along its own path; the data-driven model learns, from
// every path (converted or not), how much each campaign changes the chance of
// converting, and splits by Shapley value (Shapley 1953; Dalessandro et al.
// 2012; Shao & Li 2011): each campaign's average marginal gain over every
// order in which the path's campaigns could have joined.

export interface Touch {
  campaign: string;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface Path {
  touches: readonly Touch[];
  converted: boolean;
  /** When it converted (for time decay); the last touch's time if not. */
  at: number;
}

export type RuleModel = 'last_click' | 'first_touch' | 'linear' | 'time_decay' | 'position';
export const RULE_MODELS: readonly RuleModel[] = ['last_click', 'first_touch', 'linear', 'time_decay', 'position'];
/** Time decay halves a touch's weight every week before the conversion. */
export const HALF_LIFE_MS = 7 * 86_400_000;

/** One conversion's credit per campaign under a rule; sums to 1 (0 for no touches). */
export function ruleCredit(path: Path, model: RuleModel): Map<string, number> {
  const t = [...path.touches].sort((a, b) => a.at - b.at || (a.campaign < b.campaign ? -1 : 1));
  const credit = new Map<string, number>();
  const add = (c: string, w: number) => credit.set(c, (credit.get(c) ?? 0) + w);
  const [first] = t;
  if (!first) return credit;
  const last = t.at(-1) ?? first;
  const n = t.length;
  if (model === 'last_click') add(last.campaign, 1);
  else if (model === 'first_touch') add(first.campaign, 1);
  else if (model === 'linear') for (const x of t) add(x.campaign, 1 / n);
  else if (model === 'time_decay') {
    const weighted = t.map(x => ({ c: x.campaign, w: Math.pow(0.5, Math.max(0, path.at - x.at) / HALF_LIFE_MS) }));
    const total = weighted.reduce((s, x) => s + x.w, 0);
    for (const x of weighted) add(x.c, x.w / total);
  } else if (n <= 2) {
    // Position with one or two touches: split evenly.
    for (const x of t) add(x.campaign, 1 / n);
  } else {
    // Position: 40% first, 40% last, 20% shared by the middle.
    add(first.campaign, 0.4);
    add(last.campaign, 0.4);
    for (const x of t.slice(1, -1)) add(x.campaign, 0.2 / (n - 2));
  }
  return credit;
}

/** At most this many distinct campaigns per path for exact Shapley values (2^k subsets). */
export const MAX_SHAPLEY_CAMPAIGNS = 12;
/** Subsets seen fewer times than this borrow strength from smaller subsets (see value()). */
export const MIN_SUBSET_PATHS = 5;

/**
 * The data-driven model. From all paths: the conversion rate of each exact
 * set of campaigns seen (the "coalition"). A coalition's value is its rate;
 * one seen too rarely to trust uses its best-supported subset's rate instead
 * (monotone fallback, so noise in rare sets can't invent credit). Each
 * converting path's credit is then the Shapley split of its own coalition's
 * value, normalized to 1 per conversion.
 */
export function shapleyModel(paths: readonly Path[]): (path: Path) => Map<string, number> {
  const stats = new Map<string, { n: number; conv: number }>();
  const keyOf = (set: readonly string[]) => [...set].sort().join('\u0000');
  for (const p of paths) {
    const k = keyOf([...new Set(p.touches.map(t => t.campaign))]);
    const s = stats.get(k) ?? { n: 0, conv: 0 };
    s.n++;
    if (p.converted) s.conv++;
    stats.set(k, s);
  }
  const memo = new Map<string, number>();
  const value = (set: readonly string[]): number => {
    const k = keyOf(set);
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    const s = stats.get(k);
    // The empty set's rate is trusted at any count: it has no subsets to borrow from.
    let v = 0;
    if (s && (s.n >= MIN_SUBSET_PATHS || set.length === 0)) v = s.conv / s.n;
    // Not enough evidence for this exact set: the best of its one-smaller subsets.
    else for (let i = 0; i < set.length; i++) v = Math.max(v, value(set.filter((_, j) => j !== i)));
    memo.set(k, v);
    return v;
  };
  return (path: Path) => {
    const players = [...new Set(path.touches.map(t => t.campaign))].sort();
    const credit = new Map<string, number>();
    if (players.length === 0) return credit;
    if (players.length > MAX_SHAPLEY_CAMPAIGNS) return ruleCredit(path, 'linear');
    const k = players.length;
    const factorial = (m: number) => {
      let f = 1;
      for (let i = 2; i <= m; i++) f *= i;
      return f;
    };
    // Shapley: phi_i = sum over subsets S without i of |S|! (k-|S|-1)! / k! * (v(S+i) - v(S)).
    const phi = players.map((player, i) => {
      let sum = 0;
      for (let mask = 0; mask < 1 << k; mask++) {
        if ((mask >> i) & 1) continue;
        const members = players.filter((_, j) => (mask >> j) & 1);
        const weight = (factorial(members.length) * factorial(k - members.length - 1)) / factorial(k);
        sum += weight * (value([...members, player]) - value(members));
      }
      // Credit can't be negative: a campaign that seems to hurt gets none.
      return { player, gain: Math.max(0, sum) };
    });
    // Each conversion's credit sums to 1; evenly if no campaign seems to help.
    const total = phi.reduce((s, x) => s + x.gain, 0);
    for (const { player, gain } of phi) credit.set(player, total > 0 ? gain / total : 1 / k);
    return credit;
  };
}

/** Total credit per campaign over all converting paths, under one model. */
export function attribute(paths: readonly Path[], credit: (p: Path) => Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of paths) {
    if (!p.converted) continue;
    for (const [c, w] of credit(p)) out.set(c, (out.get(c) ?? 0) + w);
  }
  return out;
}
