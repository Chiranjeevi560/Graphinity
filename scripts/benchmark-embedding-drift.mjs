#!/usr/bin/env node
// Is embedding drift worth watching, and do the chosen signals see it
// (docs/adr/0019-embedding-drift.md)? Graphinity's own text model (ADR 0010)
// learns its vocabulary from posts. Here it is trained on 3,000 synthetic
// questions in six topics; then a week of new questions arrives in which a
// share comes from new topics with words it never saw. For each share:
// - whether the drift rule (src/ml/drift.ts) flags either signal: coverage
//   (share of a question's words the model knows) and similarity to the
//   training questions' centroid, both profiled on held-out questions;
// - retrieval quality (MRR, the gate's own measure) of the serving model on
//   the new week, and of a model retrained with the new topics included:
//   the quality retraining would recover.
// Three seeds per share.
//
//   node scripts/benchmark-embedding-drift.mjs
import { centroidOf, embeddingSignals } from '../apps/api/src/ml/embedding-drift.ts';
import { DRIFT_RULE, featureDrift, profilesOf } from '../apps/api/src/ml/drift.ts';
import { evaluateRetrieval, fusedScorer } from '../apps/api/src/ml/embedding-gate.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';
import { trainTextEmbedding } from '../apps/api/src/ml/text-embedding.ts';
import { corpus } from './lib/synthetic-questions.mjs';

const NEW_TOPICS = [
  ['solar panel subsidy for a {g} roof in {p}', 'which grant scheme paid for the {g} installation near {p}'],
  ['school admission fees for {g} classes in {p}', 'how much did enrolment in {g} lessons cost you in {p}'],
  ['hospital waiting time for a {g} scan in {p}', 'how many weeks did the {g} appointment queue take in {p}'],
];

/** Questions in topics the model never saw: new words, new products, new places. */
function newTopicQuestions(n, seed) {
  const r = seededRandom(seed);
  const fill = k => Array.from({ length: k }, () => `v${String(Math.floor(r() ** 2 * 5000))}`).join(' ');
  return Array.from({ length: n }, (_, i) => {
    const [title, body] = NEW_TOPICS[Math.floor(r() * NEW_TOPICS.length)];
    const g = `gadget${String(Math.floor(r() * 800))}`;
    const p = `town${String(Math.floor(r() * 300))}`;
    return {
      id: `n${String(seed)}-${String(i)}`,
      title: `${title.replace('{g}', g).replace('{p}', p)} ${fill(2)}`,
      body: `${body.replace('{g}', g).replace('{p}', p)} ${fill(6)}`,
    };
  });
}

const text = q => `${q.title}\n${q.body}`;
const results = [];
const started = performance.now();
for (const share of [0, 0.05, 0.2, 0.5]) {
  for (const seed of [1, 2, 3]) {
    const all = corpus(4500, seed);
    const training = all.slice(0, 3000);
    const reference = all.slice(3000, 3500);
    const model = trainTextEmbedding(training.map(text));
    // The centre comes from the training questions, not those profiled: a
    // centre fitted on the profiled questions sits closer to them than to any
    // new ones, and false-alarms with nothing changed (measured: PSI 0.13-0.16).
    const centroid = centroidOf(model, training.map(text));
    const profile = profilesOf(
      (s => s.coverage.map((c, i) => [c, s.centroid_similarity[i] ?? 0]))(
        embeddingSignals(model, reference.map(text), centroid),
      ),
      ['coverage', 'centroid_similarity'],
    );
    // The new week: 500 questions, `share` of them from new topics.
    const fresh = Math.round(500 * share);
    const week = [...all.slice(3500, 3500 + 500 - fresh), ...newTopicQuestions(fresh, seed * 10)];
    const signals = embeddingSignals(model, week.map(text), centroid);
    const drift = featureDrift(profile, signals);
    // What retraining with the new topics would recover: train with another 1,000 like the week.
    const more = [...all.slice(4000, 4000 + 1000 - 2 * fresh), ...newTopicQuestions(2 * fresh, seed * 10 + 1)];
    const retrained = trainTextEmbedding([...training, ...more].map(text));
    const serving = evaluateRetrieval(week, fusedScorer(model, week)).mrr;
    const after = evaluateRetrieval(week, fusedScorer(retrained, week)).mrr;
    results.push({
      share,
      seed,
      drifted: drift.filter(f => f.drifted).map(f => f.feature),
      psi: Object.fromEntries(drift.map(f => [f.feature, +f.psi.toFixed(3)])),
      mrrServing: +serving.toFixed(3),
      mrrRetrained: +after.toFixed(3),
      recoverable: +(after - serving).toFixed(3),
    });
  }
}
const byShare = {};
for (const r of results) {
  const s = (byShare[r.share] ??= { flagged: 0, runs: 0, recoverable: [], psiCoverage: [] });
  s.runs++;
  if (r.drifted.length) s.flagged++;
  s.recoverable.push(r.recoverable);
  s.psiCoverage.push(r.psi.coverage);
}
console.log(
  JSON.stringify(
    {
      rule: DRIFT_RULE,
      seconds: +((performance.now() - started) / 1000).toFixed(1),
      summary: Object.fromEntries(
        Object.entries(byShare).map(([k, s]) => [
          k,
          {
            flaggedRuns: `${String(s.flagged)}/${String(s.runs)}`,
            meanRecoverableMrr: +(s.recoverable.reduce((a, b) => a + b, 0) / s.runs).toFixed(3),
            psiCoverage: s.psiCoverage,
          },
        ]),
      ),
      results,
    },
    null,
    1,
  ),
);
