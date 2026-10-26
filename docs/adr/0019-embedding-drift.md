# ADR 0019: Embedding drift, measured by what the model can't place

- **Status:** Accepted and built 2026-10-26. Extends ADR 0018 to Graphinity's own text model
  (ADR 0010).

## Problem

The text model learns its vocabulary from consented posts and embeds a question by averaging the
vectors of its words. Words it never saw get a fixed random vector, which carries no meaning.

When people start asking about something new, two things happen:

- The model places those questions badly, so "has this been asked?" and meaning search get worse.
- Training only notices by chance, when a daily run happens to pass its gate.

## Decision

Two signals per question, judged by ADR 0018's rule (PSI ≥ 0.05 and KS significant):

- **coverage:** the share of the question's words in the model's vocabulary.
- **centroid_similarity:** cosine between the question's embedding and the centre of the
  *training* questions' embeddings.

**At training** (`src/ml/train-embedding.ts`):

- The centre is computed from the training questions.
- Both signals are profiled on the held-out questions, which the model never saw, as new ones
  will be.
- Both go into `ml_models.dataset`.

**Daily** (`src/ml/drift-monitor.ts`):

- New questions from the last week are measured with the serving weights, after checking those
  weights against their stored hash.
- Only questions whose askers allow learning from what they write are read, as training reads,
  and nothing about them is stored: one number per signal per day goes into `app.ml_drift`.
- Drift starts training at once, as for every model.

## Measurement

`scripts/benchmark-embedding-drift.mjs` trains the model on 3,000 synthetic questions in six topics.
A week of 500 new questions arrives in which a share comes from three new topics with words it
never saw. It compares:

- the serving model's retrieval quality on that week (MRR, the gate's own measure);
- that of a model retrained with the new topics: the quality retraining would recover.

Three seeds per share:

| New-topic share | Flagged runs | Coverage PSI | Recoverable MRR |
|---|---|---|---|
| 0% | 0 / 3 | 0.02–0.04 | −0.003 to +0.001 |
| 5% | 0 / 3 | 0.34–0.35 | +0.003 to +0.015 |
| 20% | **3 / 3** | 1.58–1.61 | +0.029 to +0.040 |
| 50% | **3 / 3** | 4.62–4.66 | +0.075 to +0.103 |

- The monitor flags exactly when retraining would recover a clear amount, and stays quiet when it
  wouldn't.
- At 5%, coverage PSI is already high: a few unknown-word questions land below the reference's
  minimum, where it has no share. KS, not significant at that size, keeps it unflagged. This is
  the case the two-part rule exists for.

**What the first runs showed:**

- **A centre fitted on the profiled questions themselves false-alarmed with nothing changed**
  (centroid PSI 0.13–0.16 at 0%). Those questions sit closer to their own centre than any new ones
  can. Hence a centre from the training questions and a profile from the held-out ones; a test
  proves the centre ignores held-out questions.
- **PSI couldn't see values below a constant reference.** If every held-out question used only
  known words, coverage was 1 everywhere and everything below fell into the same bin. PSI now has a
  bin below the reference's minimum and one above its maximum (ADR 0018), each with a share
  floored at 1e-4.

## Performance and scale

Per question, O(words + dims): a hash lookup per word and one embedding (128 dimensions).

- The cap of 100,000 questions a run bounds the work to roughly that many embeddings: about a
  second on one core.
- The weights (about 10 MB at 20,000 words) are loaded once a day.

## Not built, and why

- **Drift in answers:** questions are what meaning search and the Ask check embed. Answers only
  train the model.
- **A distance between whole embedding distributions** (MMD, energy distance): coverage measures
  the cause directly and tracks recoverable quality (table). A distribution distance would need its
  own permutation test for little more to act on.
