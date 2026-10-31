// Price elasticity (master charter §8): the slope of log quantity on log price,
// with a 95% interval. Observational data is confounded (prices rise with demand),
// so this is decision support for reserve prices, labelled as such, and it refuses
// to answer on too little price variation.
import { at } from '../ml/num.ts';

export interface Elasticity {
  elasticity: number;
  low: number;
  high: number;
  observations: number;
}

export function estimateElasticity(points: ReadonlyArray<{ price: number; quantity: number }>): Elasticity | null {
  const usable = points.filter(p => p.price > 0 && p.quantity > 0);
  const n = usable.length;
  if (n < 8) return null;
  const x = usable.map(p => Math.log(p.price));
  const y = usable.map(p => Math.log(p.quantity));
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (at(x, i) - mx) ** 2;
    sxy += (at(x, i) - mx) * (at(y, i) - my);
  }
  // Under about 5% spread in price, a slope says nothing.
  if (sxx / n < 0.0025) return null;
  const b = sxy / sxx;
  let rss = 0;
  for (let i = 0; i < n; i++) rss += (at(y, i) - my - b * (at(x, i) - mx)) ** 2;
  const se = Math.sqrt(rss / (n - 2) / sxx);
  return { elasticity: b, low: b - 1.96 * se, high: b + 1.96 * se, observations: n };
}

/** The revenue-maximizing markup over cost (Lerner rule); only for elastic demand. */
export function optimalPrice(cost: number, elasticity: number): number | null {
  return elasticity < -1 ? (cost * elasticity) / (elasticity + 1) : null;
}
