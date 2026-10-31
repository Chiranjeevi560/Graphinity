// Automatic tuning (master charter §6.2). ASHA (Li et al., MLSys 2020) gives many
// configurations a little budget and promotes the best third; TPE (Bergstra et al.,
// NeurIPS 2011) proposes new ones from a density ratio of good over bad; judged only
// by walk-forward folds, because a random split across time leaks the future into
// the past. Measured on smooth 2 and 6 dimensional losses at 40 and 150 trials, TPE only
// ties a Latin hypercube (mean best loss 0.150 against 0.153), so the hypercube plus halving
// is the default; TPE stays for losses with structure, where it needs to prove itself first.

export type Space = Readonly<Record<string, { min: number; max: number; log?: boolean }>>;
export type Config = Record<string, number>;

const toUnit = (v: number, s: Space[string]) =>
  s.log ? (Math.log(v) - Math.log(s.min)) / (Math.log(s.max) - Math.log(s.min)) : (v - s.min) / (s.max - s.min);
const fromUnit = (u: number, s: Space[string]) =>
  s.log ? Math.exp(Math.log(s.min) + u * (Math.log(s.max) - Math.log(s.min))) : s.min + u * (s.max - s.min);

/** Latin hypercube: n configurations, each dimension's strata used once. */
export function latinHypercube(space: Space, n: number, random: () => number): Config[] {
  const out: Config[] = Array.from({ length: n }, () => ({}));
  for (const [name, dim] of Object.entries(space)) {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j] ?? 0, order[i] ?? 0];
    }
    order.forEach((stratum, i) => {
      const c = out[i];
      if (c) c[name] = fromUnit((stratum + random()) / n, dim);
    });
  }
  return out;
}

export interface Trial {
  config: Config;
  loss: number;
}

/** One TPE proposal: of `candidates` draws around good trials, the highest ratio l(x)/g(x). */
export function proposeTpe(space: Space, trials: readonly Trial[], random: () => number, candidates = 24): Config {
  if (trials.length < 8) return latinHypercube(space, 1, random)[0] ?? {};
  const sorted = [...trials].sort((a, b) => a.loss - b.loss);
  // Hyperopt's split, about ¼√n best: a fixed quarter stays too broad to ever concentrate (measured).
  const cut = Math.max(2, Math.ceil(0.25 * Math.sqrt(sorted.length)));
  const good = sorted.slice(0, cut);
  const bad = sorted.slice(cut);
  // Narrows as evidence grows (Scott's rule), so it refines near the best instead of wandering.
  const bandwidth = 0.3 * sorted.length ** -0.2;
  const kde = (u: number, list: readonly Trial[], name: string, s: Space[string]) => {
    // Both densities carry a flat prior (as in the paper): without it, the ratio runs to the
    // edges, where few bad trials happen to be, and proposals got worse than random.
    let sum = bandwidth * Math.sqrt(2 * Math.PI);
    for (const t of list) sum += Math.exp(-(((u - toUnit(t.config[name] ?? s.min, s)) / bandwidth) ** 2) / 2);
    return sum / (list.length + 1);
  };
  const out: Config = {};
  for (const [name, s] of Object.entries(space)) {
    let best = 0.5;
    let bestRatio = -Infinity;
    for (let c = 0; c < candidates; c++) {
      const anchor = good[Math.floor(random() * good.length)];
      const centre = anchor ? toUnit(anchor.config[name] ?? s.min, s) : random();
      const gaussian = Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
      const u = Math.min(1, Math.max(0, centre + bandwidth * gaussian));
      const ratio = kde(u, good, name, s) / kde(u, bad, name, s);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = u;
      }
    }
    out[name] = fromUnit(best, s);
  }
  return out;
}

/** A budget of `n`: a quarter spread by Latin hypercube for evidence, the rest proposed by TPE. */
export function searchTpe(space: Space, n: number, loss: (c: Config) => number, random: () => number): Trial[] {
  const start = Math.max(8, Math.floor(n / 4));
  const trials: Trial[] = latinHypercube(space, Math.min(n, start), random).map(config => ({
    config,
    loss: loss(config),
  }));
  while (trials.length < n) {
    const config = proposeTpe(space, trials, random);
    trials.push({ config, loss: loss(config) });
  }
  return trials;
}

/** Successive halving: `evaluate(config, budget)` is awaited in rungs, the best 1/eta advance. */
export async function successiveHalving(
  configs: readonly Config[],
  evaluate: (config: Config, budget: number) => Promise<number> | number,
  { minBudget = 1, maxBudget = 27, eta = 3 }: { minBudget?: number; maxBudget?: number; eta?: number } = {},
): Promise<{ best: Trial; trials: Trial[]; spent: number }> {
  let alive = [...configs];
  let budget = minBudget;
  let spent = 0;
  const trials: Trial[] = [];
  let best: Trial = { config: configs[0] ?? {}, loss: Infinity };
  while (alive.length > 0) {
    const rung: Trial[] = [];
    for (const config of alive) {
      const loss = await evaluate(config, budget);
      spent += budget;
      rung.push({ config, loss });
    }
    rung.sort((a, b) => a.loss - b.loss);
    trials.push(...rung);
    const top = rung[0];
    if (top && (budget >= maxBudget || alive.length === 1)) best = top;
    if (budget >= maxBudget || alive.length === 1) break;
    alive = rung.slice(0, Math.max(1, Math.floor(rung.length / eta))).map(t => t.config);
    budget = Math.min(maxBudget, budget * eta);
  }
  return { best, trials, spent };
}

/** Train and test index ranges: each test fold lies strictly after everything trained on. */
export function walkForwardFolds(n: number, folds: number): Array<{ train: [number, number]; test: [number, number] }> {
  const size = Math.floor(n / (folds + 1));
  return Array.from({ length: folds }, (_, i) => ({
    train: [0, size * (i + 1)] as [number, number],
    test: [size * (i + 1), Math.min(n, size * (i + 2))] as [number, number],
  }));
}
