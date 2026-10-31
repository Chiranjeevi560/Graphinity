// Who an action actually helps (Künzel et al., PNAS 2019). Predicting "will they
// act" targets people who'd act anyway. The X-learner fits each arm's outcome,
// imputes per-person effects from the other arm's model, fits those, and blends by
// propensity, which handles unequal arms. Negative effect means a "sleeping dog":
// someone a nudge drives away, to suppress. Judged by Qini and AUUC, compared
// with the two-model baseline in benchmark-platform.mjs.
import { fitRidge, predictRidge, type RidgeModel } from './ridge.ts';

export interface UpliftRow {
  x: readonly number[];
  treated: boolean;
  y: number;
}

export interface XLearner {
  tau0: RidgeModel;
  tau1: RidgeModel;
  propensity: number;
}

export function fitTwoModel(rows: readonly UpliftRow[], l2 = 1): (x: readonly number[]) => number {
  const m1 = fitRidge(
    rows.filter(r => r.treated),
    l2,
  );
  const m0 = fitRidge(
    rows.filter(r => !r.treated),
    l2,
  );
  return x => predictRidge(m1, x) - predictRidge(m0, x);
}

export function fitXLearner(rows: readonly UpliftRow[], l2 = 1): XLearner {
  const treated = rows.filter(r => r.treated);
  const control = rows.filter(r => !r.treated);
  const mu1 = fitRidge(treated, l2);
  const mu0 = fitRidge(control, l2);
  const tau1 = fitRidge(
    treated.map(r => ({ x: r.x, y: r.y - predictRidge(mu0, r.x) })),
    l2,
  );
  const tau0 = fitRidge(
    control.map(r => ({ x: r.x, y: predictRidge(mu1, r.x) - r.y })),
    l2,
  );
  return { tau0, tau1, propensity: rows.length ? treated.length / rows.length : 0.5 };
}

export const effect = (m: XLearner, x: readonly number[]) =>
  m.propensity * predictRidge(m.tau0, x) + (1 - m.propensity) * predictRidge(m.tau1, x);

/** The uplift curve over the top k%, best score first, and its area over random targeting. */
export function qini(scored: ReadonlyArray<{ score: number; treated: boolean; y: number }>): {
  qini: number;
  auuc: number;
} {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  let nt = 0;
  let nc = 0;
  let yt = 0;
  let yc = 0;
  let area = 0;
  let auuc = 0;
  const totalT = scored.filter(s => s.treated).length;
  const totalC = scored.length - totalT;
  const sumT = scored.reduce((a, s) => a + (s.treated ? s.y : 0), 0);
  const sumC = scored.reduce((a, s) => a + (s.treated ? 0 : s.y), 0);
  const final = sumT - (totalC ? (sumC * totalT) / totalC : 0);
  sorted.forEach((s, i) => {
    if (s.treated) {
      nt += 1;
      yt += s.y;
    } else {
      nc += 1;
      yc += s.y;
    }
    const q = yt - (nc ? (yc * nt) / nc : 0);
    auuc += q;
    area += q - (final * (i + 1)) / sorted.length;
  });
  return sorted.length ? { qini: area / sorted.length, auuc: auuc / sorted.length } : { qini: 0, auuc: 0 };
}
