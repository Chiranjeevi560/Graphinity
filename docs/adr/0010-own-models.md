# ADR 0010: Graphinity's own models, trained only on Graphinity's data

Status: accepted 2026-10-25 (owner decision: "train everything from our data"; no pretrained
weights, no outside AI service).

## Context

Search by meaning used Cloudflare Workers AI's `bge-base-en-v1.5`. The owner decided Graphinity
must not depend on any outside AI, pretrained or hosted. Constraints that shape the design:

- $0: the API runs on Render's free plan (spins down after 15 idle minutes, 750 hours a month,
  per Render's docs). Training must fit beside the API.
- Privacy: models learn only from text people agreed to share for training, and a model trained
  on posts must never leave Graphinity's private database. The repository is public, so GitHub
  Actions (free, 4 CPUs, 16 GB) can't train on user data: its artifacts are public.
- Today the live database has no questions. Any learned model must prove itself on held-out data
  before serving, and the system must say plainly when it can't yet.

## Decision

1. **Registry** (`app.ml_models`, migration 0015): every trained version with its parameters, a
   fingerprint of exactly which records it saw, its held-out scores, the serving model's scores on
   the same data, status (`production`, `rejected`, `retired`), the reason, and, for promoted
   versions only, the weights and their SHA-256. At most one `production` per model (unique
   index); promotion retires the previous version in the same transaction under an advisory lock.
   Only system transactions can read or write it (forced RLS).
2. **Consent**: a new optional purpose, `model_training`, off by default. Training reads only
   public, non-hidden questions and answers of people who turned it on. Hidden posts are excluded
   twice: by the query, and by the read policy itself.
3. **Text embedding** (`apps/api/src/ml/text-embedding.ts`), algorithm `ppmi-svd-sif`:
   - Word vectors: positive PMI over a distance-weighted window of 5 (1/d), context smoothing
     α = 0.75, factorized by the top 128 eigenpairs with eigenvalue weighting p = 0.5, rows
     L2-normalized. Levy, Goldberg & Dagan (2015) show this matches skip-gram once given the same
     hyperparameters.
   - Eigenpairs: randomized range finder (Halko, Martinsson & Tropp 2011) with oversampling 20 and
     6 power iterations, Jacobi on the projected matrix, all in `ml/linalg.ts` with no
     dependencies. Measured on a bunched spectrum: eigenvalues within 1% at the defaults; vectors
     to 10⁻⁹ relative residual with 48 iterations (convergence is geometric, as predicted).
   - Sentence vectors: SIF (Arora, Liang & Ma 2017), a = 10⁻³, first principal component removed.
     Words never seen in training contribute a hashed vector (weight 1), so exact rare codes still
     match themselves. Text with no words gets a hashed vector of itself.
   - Deterministic: a seeded generator, fixed tie-breaking; the same corpus and seed give the same
     model, bit for bit.
4. **Quality gate** (`ml/embedding-gate.ts`): one question in five is held out by a hash of its id
   (stable as data grows; a held-out question and its answers are never trained on, by this or any
   later version). Task: given a question's details, find its own title among all held-out
   titles. The candidate is judged as it would serve, fused with word matching by reciprocal rank
   (the precheck's own k = 60 and weights 0.65 / 0.35); the baseline is what serves now: fused with
   the serving model, or BM25 (k1 = 1.2, b = 0.75) when none serves. Promotion requires at least
   30 evaluable queries and a paired bootstrap (2,000 resamples) whose 95% interval for the MRR
   difference lies entirely above zero.
5. **Training job** (`ml/training.ts`): 10 minutes after start, then daily, behind the
   `model_training` kill switch. Skips when there are fewer than 200 consented documents (fewer
   can't yield 30 evaluable held-out queries) or when the data's fingerprint hasn't changed. Runs
   on a worker thread so requests never wait. A promoted version serves at once
   (`own-embedder.ts`, swapped in place; vectors zero-padded to the 768-column HNSW index, which
   leaves cosine unchanged). Rejected versions are recorded without weights.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Pretrained models run on our own servers (MiniLM, BGE) | Ruled out by the owner: they are other organisations' AI |
| Skip-gram / CBOW (word2vec) | Equivalent quality per Levy et al., but stochastic and needs learning-rate and epoch tuning; PPMI-SVD is deterministic and exact |
| fastText (subword skip-gram) | Better for unseen words; same tuning cost. A hashed fallback covers the exact-code case here. Revisit if real data shows many misspellings |
| GloVe | Comparable; needs an iterative weighted least-squares fit |
| Train in GitHub Actions | Free and strong, but public: a model trained on posts could leak them |
| Keep Cloudflare Workers AI | Against the owner's decision |
| Words only (BM25) | What serves until a model wins its gate; never removed |

## Measurements (this Mac, Node 24; `node scripts/benchmark-text-embedding.mjs`)

Synthetic corpora: details paraphrase their title with synonyms; Zipf filler from a 20,000-word
lexicon; 2,000 products and 500 places.

| Documents | Vocabulary | Train | Peak memory growth | Artifact | Embed p50 / p95 / p99 |
|---|---|---|---|---|---|
| 8,006 | 7,715 | 5.1 s | 150 MB | 4.1 MB | 0.006 / 0.011 / 0.028 ms |
| 39,881 | 18,211 | 13.8 s | 231 MB | 9.6 MB | 0.005 / 0.008 / 0.025 ms |

Held-out quality at 8,006 documents (600 queries): model alone MRR 0.933, fused 0.973, BM25 alone
0.997. **The gate refused**: in this data the details always repeat the title's product and city,
so words alone are nearly perfect and any added ranking can only cost a little. A co-occurrence
model earns its place where the same thing is said in different words, which synthetic text can't
honestly stand in for. The real verdict comes from real posts, every night, by this gate.

Building the PPMI matrix straight from sorted keys (not per-row maps) cut peak memory from 304 MB
to 150 MB at 8,000 documents. Render's free instance memory isn't stated on its pricing or
free-tier pages; if training ever risks it, switch `model_training` off.

## Consequences

- No outside AI is used for search by meaning: the Cloudflare Workers AI adapter and its
  `CF_ACCOUNT_ID` / `CF_AI_TOKEN` settings are removed. Until a model wins, search works by words
  (production) or the hashed stand-in (development).
- When a new version is promoted, stored vectors are re-embedded by the existing backfill (20 a
  minute); meanwhile meaning-search finds only re-embedded questions, and words find all.
- **Rollback**: switch `model_training` off to stop training; to stop serving a version,
  `UPDATE app.ml_models SET status = 'retired', retired_at = now() WHERE name = 'text-embedding'
  AND status = 'production';` and restart the API (it then falls back to words).
- Not yet built (next steps of the owner's list): spelling correction from Graphinity's own
  character statistics, learned ranking from picks and helpful marks (needs a feature store),
  spam and fraud models, the commerce graph and affiliate engine, enterprise analytics with
  k-anonymity and differential privacy. Each will reuse this registry, consent and gate pattern.
- Two servers would each run training; the registry's lock prevents duplicate versions but not
  duplicate work. Move training behind a job lease when a second instance exists.
