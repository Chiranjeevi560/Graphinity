// Two-tower retrieval with log-Q correction (Yi et al., RecSys 2019). In-batch softmax meets popular items as negatives
// more often than rare ones, which unfairly pushes popular items down; subtracting ln(how often an item is sampled)
// from its logit undoes that. Pure typed arrays. Whether it earns a place is benchmark-two-tower's to say (ADR 0032).
import { at } from './num.ts';
import { seededRandom } from './linalg.ts';

export interface TwoTower {
  dims: number;
  users: Float32Array;
  items: Float32Array;
}

export interface TwoTowerOptions {
  users: number;
  items: number;
  dims?: number;
  epochs?: number;
  batch?: number;
  rate?: number;
  temperature?: number;
  /** Subtract ln(sampling probability) from in-batch logits. */
  logQ?: boolean;
  seed?: number;
}

function normalizeRow(m: Float32Array, row: number, d: number): void {
  let sum = 0;
  for (let i = 0; i < d; i++) sum += at(m, row * d + i) ** 2;
  const scale = sum ? 1 / Math.sqrt(sum) : 1;
  for (let i = 0; i < d; i++) m[row * d + i] = at(m, row * d + i) * scale;
}

export function trainTwoTower(
  pairs: ReadonlyArray<readonly [user: number, item: number]>,
  options: TwoTowerOptions,
): TwoTower {
  const { users: nu, items: ni, dims = 32, epochs = 8, batch = 128, rate = 0.1, temperature = 0.1 } = options;
  const random = seededRandom(options.seed ?? 1);
  const users = new Float32Array(nu * dims).map(() => random() - 0.5);
  const items = new Float32Array(ni * dims).map(() => random() - 0.5);
  for (let r = 0; r < nu; r++) normalizeRow(users, r, dims);
  for (let r = 0; r < ni; r++) normalizeRow(items, r, dims);
  const counts = new Float64Array(ni);
  for (const [, item] of pairs) counts[item] = at(counts, item) + 1;
  const logQ = counts.map(c => (options.logQ ? Math.log(Math.max(c, 1) / pairs.length) : 0));
  const order = Array.from(pairs.keys());
  const probabilities = new Float64Array(batch);
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [at(order, j), at(order, i)];
    }
    for (let start = 0; start + batch <= order.length; start += batch) {
      const members = order.slice(start, start + batch).map(i => pairs[i] ?? ([0, 0] as const));
      for (let a = 0; a < batch; a++) {
        const user = members[a]?.[0] ?? 0;
        let top = -Infinity;
        for (let b = 0; b < batch; b++) {
          const item = members[b]?.[1] ?? 0;
          let s = 0;
          for (let i = 0; i < dims; i++) s += at(users, user * dims + i) * at(items, item * dims + i);
          const logit = s / temperature - at(logQ, item);
          probabilities[b] = logit;
          if (logit > top) top = logit;
        }
        let total = 0;
        for (let b = 0; b < batch; b++) {
          const p = Math.exp(at(probabilities, b) - top);
          probabilities[b] = p;
          total += p;
        }
        // Softmax gradient: towards this row's own item, away from each by how likely it looked.
        for (let b = 0; b < batch; b++) {
          const item = members[b]?.[1] ?? 0;
          const g = ((b === a ? 1 : 0) - at(probabilities, b) / total) * rate;
          if (!g) continue;
          for (let i = 0; i < dims; i++) {
            const u = at(users, user * dims + i);
            const v = at(items, item * dims + i);
            users[user * dims + i] = u + g * v;
            items[item * dims + i] = v + g * u;
          }
          normalizeRow(items, item, dims);
        }
        normalizeRow(users, user, dims);
      }
    }
  }
  return { dims, users, items };
}

/** Serving scores are the plain dot product: the correction belongs to training only. */
export function topItems(model: TwoTower, user: number, k: number, skip: ReadonlySet<number> = new Set()): number[] {
  const { dims, users, items } = model;
  const n = items.length / dims;
  const scored: Array<[number, number]> = [];
  for (let item = 0; item < n; item++) {
    if (skip.has(item)) continue;
    let s = 0;
    for (let i = 0; i < dims; i++) s += at(users, user * dims + i) * at(items, item * dims + i);
    scored.push([s, item]);
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(x => x[1]);
}
