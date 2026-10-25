# ADR 0014: Exploration in routing, only where uncertainty justifies it

- **Status:** Accepted 2026-10-25. Built and switched off: it acts only when a routing model serves
  (ADR 0013) **and** the owner turns on `routing_exploration`.
- **Owner request:** "a production-grade exploration and exploitation framework … only explore when
  uncertainty justifies it … exploration must never noticeably reduce user experience", choosing the
  algorithm "based on measurable engineering merit".
- **Spec:** §11.2 reserves the last place of each wave for a newcomer, ranked by Ψ plus a UCB1
  bonus. With exploration on, that place is decided by this framework instead, and ADR 0001's
  table records it.

## Decision

Four places of each wave are untouched: the best current choices. The last place goes either to
exploitation's own next choice, or to someone the model is genuinely unsure about.

1. **Posterior** (`ml/routing-model.ts`, `ml/logistic.ts`):
   - **Weights:** the routing model's Laplace approximation, a Gaussian whose mean is the fitted
     weights and whose covariance is the inverse curvature there (the standard approach for
     Bayesian logistic models in production ranking; Chapelle & Li 2011). Weights held at 0 are
     certain by construction.
   - **People:** each person also has an effect the factors don't capture, with prior N(0, τ²).
     - **Their record:** from their own settled routes, labelled exactly as training labels them,
       each stage gets a residual r = Σ(y − p) and information I = Σ p(1 − p). Quality counts
       only routes they answered on judged questions.
     - **Posterior (Laplace):** mean τ²r / (1 + τ²I), variance τ² / (1 + τ²I). Someone never asked
       is as uncertain as people get. Someone asked often who never helped is pulled down by their
       record, not just narrowed by their count.
     - **τ** is estimated per stage by approximate marginal likelihood over people's residuals. It
       is 0 when people don't measurably differ, and below 30 people. It is biased low: the
       residuals come from the same fit, and the factors already include each person's history.
       So exploration errs timid, not reckless.
   - **Pinned weights:** weights held at 0 by the non-negative constraint get no variance, so
     exploration never tries "what if trust mattered more" from the boundary. That is a known
     limit.
2. **Thompson sampling** (`ml/routing-bandit.ts`): one plausible model is drawn from the posterior,
   and its favourite among exploitation's next choice and everyone else eligible wins the draw.
3. **Gates:** the winner takes the place only if all three hold. Otherwise exploitation's choice
   takes it, exactly as if there were no exploration.
   - **Uncertainty justifies it:** the posterior gives the winner at least a 25% chance of beating
     exploitation's choice (64 paired draws).
   - **It costs little:** the winner's expected chance of helping is at least half that choice's.
   - **Fairness and abuse:** the person has had fewer than 3 exploration routes in 7 days. A
     database trigger enforces this too, so no one, and no farm of fresh accounts, collects
     exploration.
4. **Logging:** every decided place records its reason (`explored`, `best_already`,
   `not_uncertain_enough`, `too_costly`, `capped`), the chance that it would be better, the
   model's prediction, and its **propensity**.
   - **Propensity:** the probability the procedure gives the place to that person. It is estimated
     by repeating the draw 128 times; each winner's gate verdict is computed once, from its own
     seeded stream, so the procedure is the same in every repetition.
   - **Determinism:** randomness is seeded by (question, wave, model version), so the same inputs
     always give the same decision. The other candidates' factors aren't stored (they are about
     other people), so a past decision can't be rebuilt from the database alone.
   - **Selection bias:** exploration depends only on recorded factors, each candidate's record and
     that seed, so training a model conditional on factors stays unbiased (selection on
     observables). That is why decided places train like any exploit route (`explore` = false);
     only the spec's newcomer place, with its bonus, is still left out.
   - **What the logs can evaluate:** the never-explore policy, whose propensity is high. Rarely
     explored people have small propensities, and the 128-draw estimate (which counts the actual
     draw) overstates small ones a little. A winner the gates refuse has propensity 0. So the logs
     don't support evaluating arbitrary other policies.
5. **Monitoring and automatic demotion** (`ml/routing-monitor.ts`, daily):
   - **Calibration:** on settled, judged routes the serving model ranked, helpful answers observed
     (O) are compared with the sum of its predictions (E). Predictions are recorded **at each
     route's real wave**: waves 2 and 3 help less, and comparing them with wave-1 predictions would
     retire a sound model. If z = (O − E)/√Σp(1−p) < −2.58 and O < 0.8·E, the model is retired
     automatically with its reason, and routing returns to Ψ at once (the in-memory model is
     cleared first, even if reloading fails).
   - **No return by the back door:** the same calibration check is part of the promotion gate, so a
     model that would be retired can't be promoted. A retirement also moves the judging window, so
     the next candidate is judged only on questions asked after it.
   - **Selection in the report:** the SNIPS sample keeps only questions the asker judged, and
     whether they judge happens after routing. The bias this adds is small; it is stated here.
   - **Exploration's cost:** each day logs what exploration found and cost. The value of never
     exploring is estimated without bias from the logged propensities (SNIPS; Swaminathan &
     Joachims 2015), alongside what was actually got.
6. **Online learning:** the posterior is refitted nightly on everything settled. That is online
   learning in daily batches; per-event updates would add complexity without changing a decision
   at today's volume.

## Why this algorithm (`node scripts/benchmark-exploration.mjs 12`, Apple M2)

An online simulation (`ml/routing-online-sim.ts`):
- **Population:** 30 days of 30 questions; 300 people plus 4 joining daily, some of them hidden
  experts.
- **Hidden truth:** each person has effects no factor shows.
- **Factors:** computed from each person's real history as it builds (as in production).
- **Retraining:** nightly, with λ fixed at 1 to keep the sweep tractable (production
  cross-validates it).
- **Comparison:** every policy fills the same four places and uses the newcomer place until the
  first model exists; only the last place differs.
- **Rivals:** tuned over small grids. Results are paired differences from greedy over 12 seeds,
  ± standard error.
- **Two worlds:** *independent* (each person asked can help) and *competing* (the asker picks one
  answer; value is the chance anyone helps). The earlier 3-seed version of this table made gated
  Thompson look like the outright winner; the review was right that it couldn't tell.

| Last-place policy | Independent: regret vs greedy | Competing: regret vs greedy | Last-place cost (ind. / comp.) | Explores | Decision |
|---|---|---|---|---|---|
| Spec's newcomer place (today) | **+90.2 ± 10.2** | **+9.9 ± 1.3** | 0.104 / 0.107 | 82% | — |
| ε-greedy, best ε (0.05 / 0.1) | +1.7 ± 11.6 | −0.3 ± 1.4 | 0.008 / 0.014 | 7–12% | — |
| GLM-UCB, best α (1 / 0.5) | **−13.9 ± 7.5** | +1.0 ± 2.5 | −0.003 / 0.011 | 23–25% | 0.9 ms |
| Thompson, ungated | −6.3 ± 11.8 | +1.5 ± 1.5 | 0.013 / 0.036 | 49–63% | 1.7 ms |
| **Thompson, gated (chosen)** | **−8.5 ± 6.9** | +2.4 ± 1.9 | 0.004 / 0.014 | 33–44% | 3.7–4.9 ms |

What the evidence says, plainly:
1. **Today's newcomer place is clearly the costliest policy in both worlds.** It gives the place to
   any new account, whether or not that teaches anything.
2. **When people help independently,** GLM-UCB and gated Thompson both beat never exploring, and
   they can't be told apart from each other (difference about 5, standard errors about 7).
3. **When answers compete,** no exploration policy pays for itself within 30 days. Gated Thompson
   costs about 2.4 of greedy's 53.6 regret, about 0.27 percentage points of "someone helped" per
   question: small but real.

Why gated Thompson anyway, on merits the regret numbers can't separate:
- **Unbiased evaluation:** UCB is deterministic, so every decision has propensity 0 or 1 and the
  logs can't evaluate anything without bias. Thompson's randomness is what makes the logged
  propensities, and so later unbiased evaluation, possible. Logging and evaluating every decision
  was required.
- **Explicit gates:** they implement "only explore when uncertainty justifies it", and cut
  ungated Thompson's last-place cost by about three quarters.
- **Latency is irrelevant:** 4 ms per wave, in the background routing job, not on any request.

Latency: 3.7–4.9 ms per decision. That is 128 propensity draws, plus at most one 64-draw comparison
per distinct winner, over about 30 candidates, plus loading their records (one query per wave).
Memory is negligible: 12×12 Cholesky factors cached per model.

## Mutation testing

18 rules broken on purpose; all 18 are caught.

Three survived the first round, and each time the test was too weak:
- **The safety gate:** the test candidates were as good as the greedy pick, so it never bound. The
  new test uses a probed case where only the safety gate refuses.
- **Routing reading each candidate's record:** no database test had a candidate whose record
  mattered. The new test's person has fresh-looking factors but a 180-day record of never
  answering.
- **The cap's lock:** the race test usually ran its second transaction after the first committed,
  so it passed with or without the lock. It now holds the first open, shows the second waiting,
  and fails without the lock.

The simulator the policy was chosen with has its own invariant tests: no policy beats the oracle,
runs are reproducible, every policy starts the same way, and the newcomer place costs more.

## Rollback

- **Exploration off:** switch `routing_exploration` off. The next routing run (within a minute)
  uses the newcomer place again.
- **Stop serving:** retire the routing model, or let automatic demotion do it.
- **Schema:** the new columns are additive and nullable; old code ignores them.

## Not done (stated plainly)

- **Simulation only:** the live database has no routes, so nothing here has run on real people.
- **No user-facing reason:** a person isn't told when they were asked to explore. The reason is
  recorded for the owner, not shown on the routed person's screen (that's a screen change).
- **Off-policy evaluation of a new model:** a candidate model can be evaluated on logged
  exploration with the propensities, but the promotion gate (ADR 0013) doesn't use them yet; it
  still judges against Ψ on held-out questions.
- **The cap under concurrency:** two routing runs at once (two servers during a deploy) are
  serialized per person by an advisory lock in the trigger (migration 0018). The second is refused,
  and that place falls back to exploitation's choice instead of failing the wave. The lock is
  tested with two concurrent transactions. The application-level fallback after a refusal happens
  only in that race, and isn't exercised end to end.
- **Account farms:** N fresh accounts can take up to 3N exploration routes a week, each costing at
  most half a place's expected value. That is bounded, and the old newcomer place had no cap at all.
