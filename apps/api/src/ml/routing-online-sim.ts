// An online simulation of routing over weeks (ADR 0014), for choosing and
// testing the exploration policy: people keep joining, some of them hidden
// experts; each person's factors come from their real history as it builds
// up (helpful rate, pick rate, answer rate), as in production; the model is
// retrained every night on everything logged so far. Every policy fills the
// same four exploit places the same way and differs only in the last place,
// so differences are the exploration policy's alone.
//
// Truth per person: P(answers) = σ(4(a − ½) + bₐ), P(helps | answers) =
// σ(4(e − ½) + b_q), with hidden availability a, expertise e, and personal
// effects bₐ, b_q ~ N(0, 0.7²) that no factor shows. Regret is measured
// against an oracle that knows these.
import { gaussian, seededRandom } from './linalg.ts';
import { sigmoid } from './logistic.ts';
import {
  decideLastPlace,
  NO_HISTORY,
  personHistory,
  seedFor,
  ucbScore,
  type ExploreCandidate,
  type PastRoute,
} from './routing-bandit.ts';
import { scoreRouting, trainRoutingModel, type RoutingExample, type RoutingModel } from './routing-model.ts';
import { coldBonus, FACTOR_ORDER, psiOfVector } from '../routing-score.ts';
import { wilsonLowerBound } from '../reputation.ts';

export type Policy = 'psi-newcomer' | 'greedy' | 'epsilon' | 'glm-ucb' | 'thompson' | 'thompson-gated';

interface Person {
  id: string;
  joined: number;
  availability: number;
  expertise: number;
  effectA: number;
  effectQ: number;
  proximity: number;
  country: number;
  trust: number;
  activity: number;
  asked: number;
  answered: number;
  helped: number;
  explored: number[];
  /** Their settled routes, as the person posterior reads them. */
  history: PastRoute[];
}

export interface OnlineResult {
  policy: Policy;
  questions: number;
  /** Σ over questions of (oracle's expected helpful answers − the policy's). */
  regret: number;
  expectedHelped: number;
  /** The last place's expected helpful answers, and what exploitation would have put there. */
  lastPlace: number;
  greedyLastPlace: number;
  explorations: number;
  /** Of the strongest tenth of people who joined during the run: share ever asked, and asked in exploit places. */
  gemsReached: number;
  gemsExploited: number;
  decisionMs: number;
}

export function simulateOnline(options: {
  policy: Policy;
  days?: number;
  questionsPerDay?: number;
  seed?: number;
  /** ε for 'epsilon', α for 'glm-ucb' (tuned in the benchmark, not fixed). */
  epsilon?: number;
  alpha?: number;
  /**
   * 'independent': each person asked can help on their own. 'competing': the
   * asker picks one answer, so at most one person helps per question, and a
   * question's value is the chance anyone helps.
   */
  world?: 'independent' | 'competing';
}): OnlineResult {
  const competing = options.world === 'competing';
  const days = options.days ?? 40;
  const perDay = options.questionsPerDay ?? 40;
  const random = seededRandom(options.seed ?? 1);
  const normal = gaussian(random);
  const policyRandom = seededRandom((options.seed ?? 1) * 31 + 7);
  const clip = (x: number) => Math.max(0, Math.min(1, x));
  const people: Person[] = [];
  const join = (day: number) => {
    const expertise = random();
    people.push({
      id: `p${String(people.length)}`,
      joined: day,
      availability: random(),
      expertise,
      effectA: 0.7 * normal(),
      effectQ: 0.7 * normal(),
      proximity: clip(expertise + 0.25 * normal()),
      country: [0, 0.5, 0.8][Math.floor(random() * 3)] ?? 0,
      trust: clip(0.6 * expertise + 0.3 * normal()),
      activity: random(),
      asked: 0,
      answered: 0,
      helped: 0,
      explored: [],
      history: [],
    });
  };
  for (let i = 0; i < 300; i++) join(-30);
  const truth = (p: Person) => ({
    a: sigmoid(4 * (p.availability - 0.5) + p.effectA),
    q: sigmoid(4 * (p.expertise - 0.5) + p.effectQ),
  });
  const trueHelp = (p: Person) => {
    const t = truth(p);
    return t.a * 0.8 * t.q;
  };
  const factorsOf = (p: Person) => {
    const f: Record<(typeof FACTOR_ORDER)[number], number> = {
      proximity: p.proximity,
      reputation: clip((p.helped + 1) / (p.answered + 3)),
      country: p.country,
      trust: p.trust,
      helpful: wilsonLowerBound(p.helped, p.answered),
      selection: (p.helped + 1) / (p.answered + 4),
      responsiveness: (p.answered + 1) / (p.asked + 2),
      activity: p.activity,
      diversity: 1,
    };
    return FACTOR_ORDER.map(k => clip(f[k]));
  };
  const log: RoutingExample[] = [];
  let model: RoutingModel | null = null;
  const result: OnlineResult = {
    policy: options.policy,
    questions: 0,
    regret: 0,
    expectedHelped: 0,
    lastPlace: 0,
    greedyLastPlace: 0,
    explorations: 0,
    gemsReached: 0,
    gemsExploited: 0,
    decisionMs: 0,
  };
  const exploitedGem = new Set<string>();
  let routes = 0;
  for (let day = 0; day < days; day++) {
    for (let j = 0; j < 4; j++) join(day);
    const usedToday = new Map<string, number>();
    for (let n = 0; n < perDay; n++) {
      const questionId = `${String(day)}:${String(n)}`;
      const eligible = people.filter(p => p.joined <= day && (usedToday.get(p.id) ?? 0) < 3);
      const pool: Person[] = [];
      while (pool.length < Math.min(30, eligible.length)) {
        const p = eligible[Math.floor(random() * eligible.length)];
        if (p && !pool.includes(p)) pool.push(p);
      }
      const facts = new Map(pool.map(p => [p.id, factorsOf(p)]));
      const exploitScore = (p: Person) =>
        model ? scoreRouting(model, facts.get(p.id) ?? []) : psiOfVector(facts.get(p.id) ?? []);
      const ranked = [...pool].sort((x, y) => exploitScore(y) - exploitScore(x) || (x.id < y.id ? -1 : 1));
      const exploit = ranked.slice(0, 4);
      const rest = ranked.slice(4);
      const greedy = rest[0];
      if (!greedy) continue;
      const candidate = (p: Person): ExploreCandidate => ({
        id: p.id,
        factors: facts.get(p.id) ?? [],
        history: model ? personHistory(model, p.history) : NO_HISTORY,
        exploredThisWeek: p.explored.filter(d => d > day - 7).length,
      });
      const started = performance.now();
      let last: Person = greedy;
      let explored = false;
      const newcomers = rest.filter(p => day - p.joined < 14);
      // Every policy starts the same way: the newcomer place until there is a model to explore with.
      if (options.policy === 'psi-newcomer' || !model) {
        // Today's production: the newcomer place by Ψ plus the UCB1 bonus.
        const bonus = (p: Person) => psiOfVector(facts.get(p.id) ?? []) + 0.12 * coldBonus(p.asked, routes);
        const best = [...newcomers].sort((x, y) => bonus(y) - bonus(x))[0];
        if (best) {
          last = best;
          explored = best !== greedy;
        }
      } else if (options.policy === 'epsilon') {
        if (policyRandom() < (options.epsilon ?? 0.2)) {
          last = rest[Math.floor(policyRandom() * rest.length)] ?? greedy;
          explored = last !== greedy;
        }
      } else if (options.policy === 'glm-ucb') {
        const m = model;
        const alpha = options.alpha ?? 1;
        const best = [...rest].sort((x, y) => ucbScore(m, candidate(y), alpha) - ucbScore(m, candidate(x), alpha))[0];
        if (best) {
          last = best;
          explored = best !== greedy;
        }
      } else if (options.policy === 'thompson' || options.policy === 'thompson-gated') {
        const decision = decideLastPlace(model, candidate(greedy), rest.slice(1).map(candidate), seedFor(questionId), {
          gated: options.policy === 'thompson-gated',
        });
        last = rest.find(p => p.id === decision.id) ?? greedy;
        explored = last !== greedy;
      }
      result.decisionMs += performance.now() - started;
      const chosen = [...exploit, last];
      const oracle = [...pool].sort((x, y) => trueHelp(y) - trueHelp(x)).slice(0, 5);
      // Independent: expected helpful answers. Competing: the chance that anyone helps.
      const valueOf = (set: readonly Person[]) =>
        competing ? 1 - set.reduce((s, p) => s * (1 - trueHelp(p)), 1) : set.reduce((s, p) => s + trueHelp(p), 0);
      const value = valueOf(chosen);
      result.regret += valueOf(oracle) - value;
      result.expectedHelped += value;
      result.lastPlace += trueHelp(last);
      result.greedyLastPlace += trueHelp(greedy);
      result.questions++;
      if (explored) {
        result.explorations++;
        last.explored.push(day);
      }
      const judged = random() < 0.8;
      const outcomes = chosen.map(p => {
        const t = truth(p);
        const responded = random() < t.a;
        return { p, responded, helped: responded && judged && random() < t.q, q: t.q };
      });
      // Competing: the asker picks one helpful answer (the best), the rest don't count as helping.
      if (competing) {
        const best = outcomes.filter(o => o.helped).sort((x, y) => y.q - x.q)[0];
        for (const o of outcomes) o.helped = o === best;
      }
      for (const { p, responded, helped } of outcomes) {
        log.push({
          questionId,
          askerId: `a${String(Math.floor(random() * 60))}`,
          wave: 1,
          factors: facts.get(p.id) ?? [],
          responded,
          helped,
          judged,
          profileId: p.id,
        });
        p.history.push({ factors: facts.get(p.id) ?? [], wave: 1, responded, helped, judged });
        p.asked++;
        if (responded) p.answered++;
        if (helped) p.helped++;
        usedToday.set(p.id, (usedToday.get(p.id) ?? 0) + 1);
        routes++;
        if (exploit.includes(p)) exploitedGem.add(p.id);
      }
    }
    // Nightly retraining on everything so far (from day 2, once there is something to learn from).
    // λ fixed at 1 here (one fit per stage, not cross-validation's 16): the benchmark runs hundreds
    // of simulated months; production keeps cross-validation.
    if (day >= 1) model = trainRoutingModel(log, { lambdas: [1] });
  }
  const joinedDuring = people.filter(p => p.joined >= 0);
  const cut = [...joinedDuring].sort((x, y) => trueHelp(y) - trueHelp(x));
  const gems = cut.slice(0, Math.max(1, Math.floor(cut.length / 10)));
  result.gemsReached = gems.filter(g => g.asked > 0).length / gems.length;
  result.gemsExploited = gems.filter(g => exploitedGem.has(g.id)).length / gems.length;
  return result;
}
