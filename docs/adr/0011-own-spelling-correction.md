# ADR 0011: Spelling correction learned from Graphinity's own posts

Status: accepted 2026-10-25 (owner: "spelling correction learned from our own data"; same rules as
ADR 0010: no outside dictionary, model or AI).

## Context

The precheck ("has this been asked already?") searches by words. A typo ("cusotms dity") finds
nothing by words, and Graphinity's own text model (ADR 0010) hasn't served yet, so search by
meaning can't rescue it either. People typing on phones, often in a second language, make exactly
these mistakes. ADR 0010's constraints still hold: $0, train beside the API on Render's free plan,
learn only from consented public posts, prove quality on held-out data before serving.

## Decision

1. **Model** (`apps/api/src/ml/spelling.ts`, algorithm `symspell-bigram-channel`):
   - Vocabulary: every word of the training posts seen at least twice (a word written once is
     usually a name, a code or itself a typo), with counts and the word pairs seen at least twice.
   - Letters are grapheme clusters (`Intl.Segmenter`, with a fast path for plain ASCII), so a
     Telugu consonant with its vowel sign is one letter and changing it is one edit.
   - Candidates: symmetric-delete lookup (SymSpell, Garbe 2012) up to distance 2, indexing only the
     first 7 letters of each word (SymSpell's prefix length). Every candidate's full distance is
     then checked, so nothing within distance 2 is missed. A test compares it with a full scan of
     the vocabulary and finds the same words every time.
   - Distance: optimal string alignment (Levenshtein plus adjacent transpositions).
   - Choice: noisy channel (Kernighan, Church & Gale 1990). Score = log P(word | previous word) −
     λ · edits, where P is a bigram model with Dirichlet smoothing towards the unigram (MacKay &
     Peto 1995, prior weight μ). Leaving the word as written is a hypothesis too, scored `keep`: a
     correction is made only when it scores higher.
   - Never corrected: words the vocabulary knows (correcting one real word into another needs
     context this model doesn't have), words under 4 or over 20 letters, anything containing a
     digit or symbol (codes like "BOE2"), and the last word of a draft until something follows it
     (it may be half-typed). Context is the previous word *as corrected*.
2. **Gate** (`ml/spelling-gate.ts`, `ml/train-spelling.ts`): the same held-out questions as ADR
   0010 (one in five by a hash of the id; never trained on).
   - Test words: known words of held-out posts with injected typos (80% one edit, 20% two; Damerau
     1964), never producing a real word, plus held-out words the vocabulary doesn't know, which
     must be left alone. A hash splits them into a tuning half and a test half.
   - Tuning: λ ∈ {2, 3, 4, 5, 6, 8, 10} × μ ∈ {1, 5, 20, 100}; for each, `keep` is swept over every
     cut between distinct candidate scores. The choice is the most fixes whose precision clears the
     bar. Scores are reported on the test half, which tuning never saw.
   - Promotion: at least 100 test typos and 30 changed words, a Wilson 95% lower bound of precision
     (right changes / all changes) of at least 80%, and no fewer typos fixed than the serving
     version on the same test words.
3. **Training** joins the daily job (`ml/training.ts`): same worker thread, same registry
   (`app.ml_models`, name `spelling`), same consent and `model_training` kill switch, same skips
   (under 200 documents, or unchanged data). No migration: the registry already holds any model.
4. **Use** (`POST /questions/precheck`): corrections only *add* words to the word search
   ("cusotms" also looks for "customs"). What was typed is still searched as typed, and is never
   changed or sent back. A question holding every corrected word counts as holding every word.
   Meaning is still computed from the text as typed.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| A dictionary (Hunspell, SCOWL) or a pretrained corrector | Outside data; against the owner's decision. Also wrong for Graphinity's words (place names, "BOE", Telugu and Hindi) |
| Norvig's edits-then-lookup | Generates every edit of the typo (≈ 54n + 25 at distance 1, squared at 2): far slower at distance 2 than symmetric deletes |
| BK-tree | Exact, but each lookup visits a large share of the tree at distance 2 |
| Character n-gram language model | Better at real-word errors; needs more data than Graphinity has and a decoder. Revisit with real typos |
| Learning a per-character confusion matrix (Brill & Moore 2000) | Needs pairs of real typos and their fixes, which only come from people. A flat λ per edit is the honest prior until then |
| Always correct when a candidate exists (no `keep`) | Measured: it "corrected" correct rare words and names; the sweep lets the data choose when to leave words alone |
| Showing "Did you mean …?" | A screen change nobody asked for; the server-side search gain comes first. Offered to the owner separately |

## Measurements (Apple M2, Node 24; `node scripts/benchmark-spelling.mjs 2000 10000 40000`)

Synthetic: a 20,000-word lexicon of made-up words at Zipf frequencies (so many words sit one or two
edits from another), plus a name written once in every question.

| Questions | Vocabulary | Full run (tune + train + score) | Peak memory growth | Artifact | Serving index | Correct one word p50 / p95 / p99 |
|---|---|---|---|---|---|---|
| 2,000 | 4,155 | 1.6 s | 111 MB | (not promoted) | 0.05 s | 0.025 / 0.048 / 0.061 ms |
| 10,000 | 13,649 | 3.9 s | 101 MB | 0.61 MB | 0.15 s | 0.047 / 0.106 / 0.140 ms |
| 40,000 | 19,832 | 7.5 s | 226 MB | 2.12 MB | 0.23 s | 0.066 / 0.170 / 0.231 ms |

Held-out test half (never seen by tuning):

| Questions | Test typos | Fixed | Right when it changed a word (95% lower bound) | Gate |
|---|---|---|---|---|
| 2,000 | 1,538 | 96.4% | 81.3% (79.4%) | **refused**: lower bound under 80% |
| 10,000 | 1,827 | 94.9% | 89.8% (88.4%) | promoted |
| 40,000 | 1,932 | 95.3% | 95.3% (94.3%) | promoted |

At 2,000 questions, many held-out words were rare words the vocabulary hadn't seen yet, sitting
close to common ones. Changing them was wrong often enough that the gate said no, which is the
right answer. With more data the vocabulary covers them.

What the measurements changed:
- The first version had no `keep`. It changed 1,854 words for 1,538 typos at 2,000 questions;
  adding `keep` and sweeping it was the fix.
- Indexing whole words took 122 MB for 20,000 words (922,113 keys). Indexing 7-letter prefixes
  with compact lists takes 18 MB (66,105 keys), with identical held-out scores.
- Splitting each candidate with `Intl.Segmenter` made lookups about 5× slower. Plain ASCII now
  skips it, and the typed word is split once per lookup.
- Widening the grid (λ up to 20, μ up to 2,000) changed precision by under 0.1 point and made runs
  30–60% slower, so it stayed as it is. μ settles at the grid's top on this data because the
  made-up words follow each other at random: there is no context to learn. Real posts will show
  whether context helps.

## Consequences

- Until a version wins, the precheck searches words as typed, exactly as before.
- A served speller holds its vocabulary in memory (18 MB at 20,000 words) and corrects a title in
  well under a millisecond. Training adds about 100–230 MB for a few seconds on the worker thread,
  beside the text model's run.
- The vocabulary holds words from consented public posts that appeared at least twice. It never
  reaches a client: corrections are used inside the search and not returned.
- **Rollback**: switch `model_training` off to stop training; to stop serving, `UPDATE
  app.ml_models SET status = 'retired', retired_at = now() WHERE name = 'spelling' AND status =
  'production';` and restart the API (it then searches words as typed).
- Not handled: real-word errors ("form" for "from"), words split or joined by a space, and
  phonetic misspellings more than two edits away. Typos in Telugu and Hindi are corrected only in
  words of 4 or more letters (as people see letters), which leaves out many short words.
- The test typos are injected, not real. Once people use the precheck, real ones (a search
  followed by an edited search) could replace them, under `search_history` consent. That is a
  separate decision for the owner.
