// Tuning and the quality gate for spelling correction (ADR 0011).
//
// Test data comes from held-out posts the model never trained on: known words
// get typos injected (80% one edit, 20% two: Damerau 1964 found about 80% of
// misspellings are a single edit), and words the training data never had are
// the "leave it alone" set, since in real text most of them are names and
// places spelled right. λ and μ are chosen on one half of the held-out words
// and reported on the other half, so the score isn't flattered by tuning.
//
// The bar: when it changes a word, it must be right at least 4 times in 5, at
// 95% confidence (Wilson's lower bound). In the precheck a correction is only
// an extra search term, so a wrong one costs a few extra candidates, while a
// right one finds a question words alone would miss.
import { createHash } from 'node:crypto';
import { isHeldOut } from './embedding-gate.ts';
import { seededRandom } from './linalg.ts';
import {
  buildIndex,
  letters as lettersOf,
  MAX_LENGTH,
  MIN_LENGTH,
  speller,
  trainSpelling,
  WORD,
  type SpellingIndex,
  type SpellingModel,
  type SpellingParams,
} from './spelling.ts';
import { tokenize } from './text-embedding.ts';

export const PRECISION_BAR = 0.8;
export const MIN_TYPOS = 100;
export const MIN_CHANGES = 30;
/** Most test words per half: bounds evaluation time; ample for the intervals used. */
export const MAX_TEST_WORDS = 2000;
export const GRID = { lambda: [2, 3, 4, 5, 6, 8, 10], mu: [1, 5, 20, 100] } as const;
export const MIN_COUNT = 2;

/** Wilson score interval lower bound at 95% (z = 1.96) for k of n. */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export interface TestWord {
  /** What the person meant (a typo's original), or the word as written for "leave alone" words. */
  intended: string;
  /** What the speller is given. */
  written: string;
  previous: string | null;
  kind: 'typo' | 'new';
}

/** One random edit: delete, insert, substitute or swap neighbours, using letters the corpus uses. */
function typo(word: string, letters: readonly string[], random: () => number, edits: number): string {
  let chars = lettersOf(word);
  for (let e = 0; e < edits; e++) {
    const i = Math.floor(random() * chars.length);
    const letter = letters[Math.floor(random() * letters.length)] ?? 'a';
    const op = Math.floor(random() * 4);
    if (op === 0 && chars.length > 1) chars = [...chars.slice(0, i), ...chars.slice(i + 1)];
    else if (op === 1) chars = [...chars.slice(0, i), letter, ...chars.slice(i)];
    else if (op === 2)
      chars[i] = letter === chars[i] ? (letters[(letters.indexOf(letter) + 1) % letters.length] ?? 'b') : letter;
    else if (i + 1 < chars.length) [chars[i], chars[i + 1]] = [chars[i + 1] ?? '', chars[i] ?? ''];
  }
  return chars.join('');
}

/** Test words from held-out text, split by a hash into a tuning half and a test half. */
export function testWords(
  heldOutDocuments: readonly string[],
  vocabulary: ReadonlySet<string>,
  seed: number,
): { tune: TestWord[]; test: TestWord[] } {
  const random = seededRandom(seed);
  const letters = [...new Set([...vocabulary].flatMap(lettersOf).filter(c => /\p{L}/u.test(c)))].sort();
  const tune: TestWord[] = [];
  const test: TestWord[] = [];
  for (const doc of heldOutDocuments) {
    const words = tokenize(doc);
    words.forEach((w, i) => {
      const length = lettersOf(w).length;
      if (length < MIN_LENGTH || length > MAX_LENGTH || !WORD.test(w)) return;
      const previous = i > 0 ? (words[i - 1] ?? null) : null;
      let item: TestWord | null = null;
      if (vocabulary.has(w)) {
        const written = typo(w, letters, random, random() < 0.8 ? 1 : 2);
        if (written !== w && !vocabulary.has(written) && lettersOf(written).length >= MIN_LENGTH)
          item = { intended: w, written, previous, kind: 'typo' };
      } else item = { intended: w, written: w, previous, kind: 'new' };
      if (!item) return;
      const half =
        createHash('sha256')
          .update(`${doc}\u0000${String(i)}`)
          .digest()
          .readUInt8(0) % 2
          ? tune
          : test;
      if (half.length < MAX_TEST_WORDS) half.push(item);
    });
  }
  return { tune, test };
}

export interface SpellingScores {
  typos: number;
  newWords: number;
  /** Words it changed, and how many of those changes gave back what was meant. */
  changed: number;
  right: number;
  precision: number;
  precisionLower: number;
  /** Of the typos, how many it fixed. */
  recall: number;
}

export function evaluateSpelling(
  model: SpellingModel,
  words: readonly TestWord[],
  built?: SpellingIndex,
): SpellingScores {
  const s = speller(model, built);
  let changed = 0;
  let right = 0;
  let typos = 0;
  let fixed = 0;
  for (const w of words) {
    if (w.kind === 'typo') typos++;
    const out = s.correct(w.written, w.previous);
    if (out === null || out === w.written) continue;
    changed++;
    if (out === w.intended) {
      right++;
      if (w.kind === 'typo') fixed++;
    }
  }
  return {
    typos,
    newWords: words.length - typos,
    changed,
    right,
    precision: changed ? right / changed : 0,
    precisionLower: wilsonLower(right, changed),
    recall: typos ? fixed / typos : 0,
  };
}

/** Clearing the bar beats not clearing it; then, among those clearing it, recall; otherwise precision. */
export function preferred(a: SpellingScores, b: SpellingScores): boolean {
  const aClears = a.precisionLower >= PRECISION_BAR;
  const bClears = b.precisionLower >= PRECISION_BAR;
  if (aClears !== bClears) return aClears;
  return aClears ? a.recall > b.recall : a.precisionLower > b.precisionLower;
}

/**
 * The best `keep` for one (λ, μ): every cut point between distinct candidate
 * scores is tried (a word is corrected when its best candidate scores above
 * `keep`), and the preferred one wins. One sort, then a single pass.
 */
export function sweepKeep(
  scored: ReadonlyArray<{ score: number; right: boolean; typo: boolean }>,
  typos: number,
  newWords: number,
): { keep: number; scores: SpellingScores } {
  const items = [...scored].sort((a, b) => b.score - a.score);
  const at = (changed: number, right: number, fixed: number): SpellingScores => ({
    typos,
    newWords,
    changed,
    right,
    precision: changed ? right / changed : 0,
    precisionLower: wilsonLower(right, changed),
    recall: typos ? fixed / typos : 0,
  });
  // Scores are log-probabilities less edit costs, so always below zero: keep = 0 corrects nothing.
  let best = { keep: items.length ? (items[0]?.score ?? 0) + 1 : 0, scores: at(0, 0, 0) };
  let right = 0;
  let fixed = 0;
  for (let k = 1; k <= items.length; k++) {
    const item = items[k - 1];
    if (!item) break;
    if (item.right) {
      right++;
      if (item.typo) fixed++;
    }
    const next = items[k];
    // Only cut between different scores: a cut inside a tie can't be served.
    if (next && next.score === item.score) continue;
    const scores = at(k, right, fixed);
    if (preferred(scores, best.scores)) best = { keep: next ? (item.score + next.score) / 2 : item.score - 1, scores };
  }
  return best;
}

/**
 * The (λ, μ, keep) with the best recall whose precision clears the bar on the
 * tuning half. Counts and the index don't depend on them, so they are built
 * once; each (λ, μ) scores every word once and `keep` is swept over those.
 */
export function tune(
  documents: readonly string[],
  words: readonly TestWord[],
): { params: SpellingParams; scores: SpellingScores } {
  const counted = trainSpelling(documents, { lambda: 0, mu: 0, minCount: MIN_COUNT, keep: 0 });
  const built = buildIndex(counted.words);
  const typos = words.filter(w => w.kind === 'typo').length;
  let best: { params: SpellingParams; scores: SpellingScores } | null = null;
  for (const lambda of GRID.lambda)
    for (const mu of GRID.mu) {
      const s = speller({ ...counted, params: { lambda, mu, minCount: MIN_COUNT, keep: 0 } }, built);
      const scored = words.flatMap(w => {
        const c = s.candidate(w.written, w.previous);
        return c ? [{ score: c.score, right: c.word === w.intended, typo: w.kind === 'typo' }] : [];
      });
      const { keep, scores } = sweepKeep(scored, typos, words.length - typos);
      if (!best || preferred(scores, best.scores)) best = { params: { lambda, mu, minCount: MIN_COUNT, keep }, scores };
    }
  if (!best) throw new Error('empty tuning grid');
  return best;
}

export interface SpellingDecision {
  promote: boolean;
  reason: string;
}

export function decideSpelling(candidate: SpellingScores, serving: SpellingScores | null): SpellingDecision {
  if (candidate.typos < MIN_TYPOS)
    return { promote: false, reason: `only ${String(candidate.typos)} test typos; ${String(MIN_TYPOS)} needed` };
  if (candidate.changed < MIN_CHANGES)
    return {
      promote: false,
      reason: `changed only ${String(candidate.changed)} words; ${String(MIN_CHANGES)} needed to judge`,
    };
  if (candidate.precisionLower < PRECISION_BAR)
    return {
      promote: false,
      reason: `right in ${(candidate.precision * 100).toFixed(1)}% of changes (95% lower bound ${(candidate.precisionLower * 100).toFixed(1)}%); the bar is ${String(PRECISION_BAR * 100)}%`,
    };
  if (serving && serving.precisionLower >= PRECISION_BAR && candidate.recall < serving.recall)
    return {
      promote: false,
      reason: `fixes fewer typos than the serving version (${candidate.recall.toFixed(3)} vs ${serving.recall.toFixed(3)})`,
    };
  return {
    promote: true,
    reason: `fixes ${(candidate.recall * 100).toFixed(1)}% of test typos, right in ${(candidate.precision * 100).toFixed(1)}% of changes (lower bound ${(candidate.precisionLower * 100).toFixed(1)}%)`,
  };
}

/** Held-out documents for spelling: the same questions the embedding holds out. */
export function splitDocuments(
  questions: ReadonlyArray<{ id: string; title: string; body: string }>,
  answers: ReadonlyArray<{ questionId: string; body: string }>,
) {
  const held = new Set(questions.filter(q => isHeldOut(q.id)).map(q => q.id));
  const text = (q: { title: string; body: string }) => (q.body ? `${q.title}\n${q.body}` : q.title);
  return {
    training: [
      ...questions.filter(q => !held.has(q.id)).map(text),
      ...answers.filter(a => !held.has(a.questionId)).map(a => a.body),
    ],
    heldOut: [
      ...questions.filter(q => held.has(q.id)).map(text),
      ...answers.filter(a => held.has(a.questionId)).map(a => a.body),
    ],
  };
}
