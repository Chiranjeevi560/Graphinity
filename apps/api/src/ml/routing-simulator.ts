// A simulated routing history with known truth (ADR 0013), for the tests and
// scripts/benchmark-routing.mjs. People have a hidden expertise and a hidden
// availability; the factors routing sees are noisy readings of them; routing
// logs waves exactly as routing.ts does (wave 2 only when wave 1 went quiet,
// wave 3 only while fewer than 3 answered), choosing by Ψ; outcomes come from
// the hidden truth. Two worlds:
//   - 'availability': helping needs being available AND expert, while Ψ puts
//     a tenth of its weight on availability. Learning should beat Ψ.
//   - 'psi': outcomes are generated from Ψ itself. Nothing can beat Ψ; the
//     gate must refuse.
// It says whether the learner and the gate behave; not how real people behave.
import { gaussian, seededRandom } from './linalg.ts';
import { sigmoid } from './logistic.ts';
import { FACTOR_ORDER, psiOfVector } from '../routing-score.ts';
import type { GateExample } from './routing-gate.ts';

export type World = 'availability' | 'psi';

export function simulateRouting(options: {
  questions: number;
  people?: number;
  askers?: number;
  world: World;
  seed?: number;
}): GateExample[] {
  const random = seededRandom(options.seed ?? 1);
  const normal = gaussian(random);
  const clip = (x: number) => Math.max(0, Math.min(1, x));
  const peopleCount = options.people ?? 400;
  const askerCount = options.askers ?? 60;
  const people = Array.from({ length: peopleCount }, (_, i) => ({
    id: `p${String(i)}`,
    expertise: random(),
    availability: random(),
    country: [0, 0.5, 0.8][Math.floor(random() * 3)] ?? 0,
  }));
  const reading = (p: (typeof people)[number]) => {
    const f: Record<(typeof FACTOR_ORDER)[number], number> = {
      proximity: clip(p.expertise + 0.2 * normal()),
      reputation: clip(p.expertise + 0.25 * normal()),
      country: p.country,
      trust: clip(0.8 * p.expertise + 0.2 * normal()),
      helpful: clip(p.expertise + 0.3 * normal()),
      selection: clip(0.5 * p.expertise + 0.25 + 0.2 * normal()),
      responsiveness: clip(p.availability + 0.15 * normal()),
      activity: clip(p.availability + 0.2 * normal()),
      diversity: 0.5 + 0.5 * random(),
    };
    return FACTOR_ORDER.map(k => f[k]);
  };
  const out: GateExample[] = [];
  for (let q = 0; q < options.questions; q++) {
    const questionId = String(q + 1);
    const askerId = `a${String(Math.floor(random() * askerCount))}`;
    const judged = random() < 0.8;
    // 30 people from the field, ranked by Ψ, taken five at a time.
    const pool = Array.from({ length: 30 }, () => people[Math.floor(random() * peopleCount)] ?? people[0])
      .filter((p, i, all) => p && all.findIndex(o => o?.id === p.id) === i)
      .map(p => ({ p, factors: reading(p as (typeof people)[number]) }))
      .sort((a, b) => psiOfVector(b.factors) - psiOfVector(a.factors));
    let answered = 0;
    for (let wave = 1; wave <= 3; wave++) {
      if (wave === 2 && answered >= 3) break;
      if (wave === 3 && answered >= 3) break;
      for (const { p, factors } of pool.slice((wave - 1) * 5, wave * 5)) {
        const person = p as (typeof people)[number];
        // Later waves answer less: the question is older and others have replied.
        const late = 0.4 * (wave - 1);
        const psi = psiOfVector(factors);
        const pRespond =
          options.world === 'psi' ? sigmoid(8 * (psi - 0.45) - late) : sigmoid(6 * (person.availability - 0.5) - late);
        const pHelp = options.world === 'psi' ? sigmoid(8 * (psi - 0.45)) : sigmoid(5 * (person.expertise - 0.5));
        const responded = random() < pRespond;
        if (responded) answered++;
        out.push({
          questionId,
          askerId,
          wave,
          factors,
          responded,
          helped: responded && judged && random() < pHelp,
          judged,
          askerAgeDays: 30,
          askedAt: Date.UTC(2026, 0, 1) + q * 3_600_000,
        });
      }
    }
  }
  return out;
}
