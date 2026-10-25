# ADR 0013: Learned routing, proven against Ψ before it serves

- **Status:** Accepted 2026-10-25. Built, gated and switched off: it serves only when a promoted model
  exists **and** the owner turns on `learned_routing`.
- **Owner request:** "Replace heuristic routing using graph intelligence, Bayesian confidence,
  expertise weighting, freshness decay, availability prediction, and reputation signals", with a
  fresh-eyes review before it stands.
- **Spec:** §11.2 fixes Ψ's nine weights as production weights. Serving learned weights bends that,
  and ADR 0001's table records it.

## Context

- **What routing has:** Ψ ranks the people a question is put to, with nine hand-set weights over
  proximity, reputation, country, trust, helpfulness, selection rate, responsiveness, activity and
  diversity. Those factors already carry the Bayesian and graph pieces (TrueSkill μ − 3σ, Wilson
  bounds, TrustRank, decay of activity).
- **What it doesn't know:** whether the weights are right. Nothing learned from what happened after
  people were asked.
- **What made learning impossible:** each route stored only three of the nine factors. Rebuilding
  them later would leak the outcome, since a person's counts at training time include the very
  answer being predicted.

## Decision

1. **Point-in-time features.** Every routing decision records its nine factors, exactly as seen,
   in `app.route_factors` (migration 0016).
   - System-only RLS: the routed person can read their route, but not these numbers, which include
     internal scores and their similarity to the other people asked.
   - The database's own checks: 64-bit floats; a CHECK for 9 values in [0, 1] (NaN, infinities and
     gaps refused); a `factors_version`; a `model_version` foreign key to the registry; a trigger
     keeping it in agreement with the route's `ranking_version`; the newcomer place always on Ψ.
   - Deleted with the route, and after 180 days.
2. **Labels**, frozen at a 14-day horizon from asking, so a later run sees the same labels:
   - responded: they answered within 7 days, and the answer isn't hidden by moderation;
   - helped: the asker picked that answer or marked it helpful by the horizon (read from
     `selections` and `helpful_marks`, not the points ledger, whose pair cap pays some help 0);
   - judged: the asker picked (even an answer since deleted) or marked anything by the horizon.
   - A route is read only after the horizon. A pick changed after it takes its question out of
     learning (what was picked first is gone).
   - Hidden questions are left out. Only exploit places are read (the newcomer place has its own
     bonus), with one factor version per run, at most 50,000 routes, newest first.
   - The share of routes a learned model ranked is recorded with each run: once one serves, it
     learns partly from its own choices.
3. **Model** (`ml/routing-model.ts`): P(helps) = P(answers) × P(helps | answers). These are two
   logistic regressions with a Gaussian prior (MAP), fitted exactly by Newton's method with
   step-halving (`ml/logistic.ts`):
   - Inputs are standardized factors. The wave is a training-only term: waves 2 and 3 run only when
     wave 1 went quiet. Scoring leaves it out.
   - The quality model learns only from questions whose asker judged something; elsewhere "didn't
     help" means "nobody looked".
   - **Trust, reputation, proximity and country can't get negative weights** (an active set that
     pins a negative weight at 0, and releases a pinned one when its gradient says it should
     grow). A ring of accounts can't teach the model to prefer whoever the defence against rings
     trusts least.
   - A factor that never varied gets weight 0. The prior strength λ ∈ {0.1, 1, 10} is chosen by
     cross-validation grouped by question.
4. **Gate** (`ml/routing-gate.ts`). The held-out set is its own fifth of questions (a salted hash,
   different from the text model's). The comparison is the same stored factors scored by the
   candidate and by Ψ recomputed from them (no newcomer bonus, no load), AUC of "helped" within each
   (question, wave). Promotion requires all of:
   - each asker counted once, from accounts at least 14 days old; at least 30 different askers;
   - an asker-resampled bootstrap whose 99% interval lies above 0, _and_ a mean gain of at least
     0.02 AUC;
   - not worse than the model already serving;
   - trust took at least 5 distinct values in training. While no moderator has picked anyone,
     trust is 0 for everyone, and one pick makes it "vary" for a few people. A model that learned
     nothing about trust mustn't replace a ranking that relies on it.
     After a rejection that measured a difference, only questions asked since are judged, so daily
     retesting on the same questions can't pass by chance in the end. A rejection that measured
     nothing (too few askers) doesn't move the window; otherwise no question could ever be both
     settled and newer, and the gate would lock shut. The code review found that in the first
     version, and a test reproduced it before the fix.
5. **Serving** (`routing.ts`): with a promoted model and the switch on, the model ranks the whole
   eligible pool for exploit places, not just Ψ's favourites. Diversity is re-scored through the
   model at each greedy pick, and the daily budget and load dampener still apply. The newcomer
   place stays Ψ plus its UCB bonus. Each route records which model ranked it.
6. **Training** runs daily, on the worker thread, behind the `model_training` kill switch. It skips
   under 200 settled routes, or when the data's fingerprint is unchanged.

## Consent and privacy

- **No consent purpose required:** training reads routing's own operational records (routes,
  answers, picks, helpful marks), which routing already uses live. The artifact is about 930 bytes:
  standardization constants and 24 weights, no per-person parameter, no text.
- **The per-route factors** are a new record about each person asked. So they are system-only and
  kept 180 days.
- **Deleted accounts:** a deleted account's routes and factors go at once (cascade). Weights trained
  partly on them remain until the next retrain.

## Evidence (`node --expose-gc scripts/benchmark-routing.mjs`, Apple M2, Node 24)

A simulated history (`ml/routing-simulator.ts`) with hidden expertise and availability, factors as
noisy readings of them, and waves logged by Ψ exactly as routing does:

| World                                          | Questions | Runs | Promoted | Mean AUC gain over Ψ | Run time |
| ---------------------------------------------- | --------- | ---- | -------- | -------------------- | -------- |
| Helping needs availability (Ψ under-weighs it) | 300       | 3    | 1        | +0.183               | 0.51 s   |
|                                                | 1,000     | 3    | 3        | +0.221               | 1.8 s    |
|                                                | 3,000     | 3    | 3        | +0.208               | 5.1 s    |
| Outcomes generated from Ψ itself               | 300       | 10   | **0**    | −0.038               | 0.29 s   |
|                                                | 1,000     | 10   | **0**    | −0.010               | 0.90 s   |
|                                                | 3,000     | 10   | **0**    | −0.003               | 2.7 s    |

- Where Ψ is the truth, the gate refused all 30 runs above. **Measured over more runs, it isn't
  never:** at 1,000 questions (about 50 askers), a 95% interval promoted 1 run in 40, and the 99%
  interval chosen still promotes **2 in 100**.
  - The asker bootstrap undercovers at about 50 askers (5-person strata make AUC coarse).
  - The falsely promoted run scored AUC 0.637 against Ψ's 0.603, so it was about as good as Ψ, and
    the harm of such a switch is small.
  - Two things guard it beyond the gate: only measured rejections move the judging window, and
    serving needs the owner's switch.
- At 99%, where Ψ is wrong, it promoted 7 of 10 runs at 300 questions (1 of the 3 benchmark runs) and 10 of 10 at 1,000.
- At the 50,000-route cap (48,465 routes): training takes 9.5 s with 49.5 MB of heap growth, on
  the worker thread. Scoring one candidate takes 0.54 µs (p50), 1.2 µs (p99).
  - The review fixes first slowed this to 39 s and 198 MB: the pin/release search refit from
    scratch, and every row copied the weights on every step.
  - Warm-starting refits and removing the copy brought it below the original 14.4 s, with
    identical results.

**Complexity.** Each Newton step costs O(n·d²) with d = 12. There are ≤ 50 steps per fit, and 2
stages × (3 λ × 5 folds + 1) fits. Serving is O(d) per candidate.

## Review

Two fresh-eyes adversarial reviews (design, then code); findings and their fixes are listed in the
commit. The code review's two blockers:

1. a rejection that measured nothing moving the judging window, locking the gate;
2. the 50,000-route cap keeping the oldest routes.
   It also flagged labels that could still change after settling, hidden answers counted as answering,
   a constrained fit that could stop short of the optimum, and trust "varying" from one moderator pick.
   All were fixed with tests. The design review's four blockers:
3. an unfair baseline;
4. rings steering the labels and the gate;
5. trust learning nothing early on;
6. factors readable by the person routed.
   All four shaped the decisions above.

## Mutation testing

33 rules broken on purpose; 31 caught. The 2 that survive are second locks, so removing them can't
change behaviour:

- The database's row security already hides moderator-removed answers from the training query.
- `candidates()` already ignores the ranker for the newcomer place.
  Eleven survived the first round. Each time the test was too weak, and it was sharpened: the
  optimum's conditions on 100 random problems, a search-found case where plain Newton doesn't
  converge, the exact MAP weight, newcomer routes in the training data, a load tie broken against
  the less-busy person, and the explore place staying Ψ's choice.

## Rollback

- **Stop serving:** switch `learned_routing` off; the next routing run (within a minute) uses Ψ for
  everyone.
- **Stop training:** switch `model_training` off.
- **Retire a version:** mark it `retired` in `app.ml_models` and restart.
- **The schema is additive:** old code ignores `route_factors`.

## Not done (stated plainly)

- **No real data:** the live database has no routes, so the gate will refuse until real outcomes
  accumulate. Everything above is shown on simulation.
- **Off-policy limits:** outcomes exist only for people routing chose. AUC among the routed doesn't
  test choices outside what Ψ picked. A small random place per wave with recorded probabilities
  (for IPS/SNIPS estimates) would fix that, but it is a change to routing's own policy and is
  offered separately.
- **Newcomer eligibility:** it still means a new account (14 days), not new to the field (the
  spec's n < 5).
- **The offline gate leans toward models that differ from Ψ:** strata are Ψ's own top picks,
  where Ψ's AUC is squeezed toward 0.5. The 0.02 margin and the 99% interval are the counterweight.
- **Fast low-quality answerers** gain through P(answers); Ψ has the same weakness.
- **One pick per question:** that makes "helped" depend on the competing answers. A conditional
  logit per question would model it better; not done.
