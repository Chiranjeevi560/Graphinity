// Spelling correction learned from Graphinity's own posts (ADR 0011): which
// words people write, how often, and which words follow which. Nothing comes
// from an outside dictionary or model.
//
//   Candidates: symmetric-delete lookup (SymSpell, Garbe 2012): every word's
//     deletions up to distance 2 are indexed once, so a typo's candidates come
//     from a handful of hash lookups, not a scan of the vocabulary. Only the
//     first 7 letters are indexed (SymSpell's prefix length): two edits within
//     the whole word are still two deletions or fewer on each side of the
//     prefixes, so nothing within distance 2 is missed (tested against a full
//     scan), and the index takes far less memory.
//   Distance: optimal string alignment (Damerau-Levenshtein with adjacent
//     transpositions), so "dutey" → "duty" and "cusotms" → "customs" are one edit.
//   Choice: the noisy channel (Kernighan, Church & Gale 1990), maximizing
//     log P(word | previous word) − λ · edits, where P is a bigram model with
//     Dirichlet smoothing towards the unigram (MacKay & Peto 1995; μ the prior
//     weight). Leaving the word as written is a hypothesis too, scored `keep`:
//     a correction is made only when it scores higher, since a word the corpus
//     hasn't seen is often a name or place spelled right. λ, μ and keep are
//     tuned on held-out data (spelling-gate.ts), not chosen.
//   A word the corpus already knows is left alone: correcting real words into
//     other real words needs context this model doesn't have.
import { valueAt } from './linalg.ts';
import { tokenize } from './text-embedding.ts';

/**
 * A word's letters as people see them (grapheme clusters). Indian scripts
 * write a vowel sign as its own code point after the consonant; an edit that
 * split them would be no letter at all.
 */
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** Printable ASCII has no combining marks, so each character is a letter; segmenting is the slow part. */
const ASCII = /^[\x20-\x7e]*$/;
export const letters = (word: string): string[] =>
  ASCII.test(word) ? word.split('') : Array.from(segmenter.segment(word), s => s.segment);

/** Letters, with their combining marks: what counts as a word to correct. */
export const WORD = /^[\p{L}\p{M}]+$/u;

export const MAX_DISTANCE = 2;
/** Shorter words have too many neighbours at distance 1-2 to correct safely. */
export const MIN_LENGTH = 4;
/** Longer tokens are codes and identifiers, not misspellings. */
export const MAX_LENGTH = 20;
/** Letters of each word that are indexed; the rest are checked when a candidate is scored. */
export const PREFIX_LENGTH = 7;

export interface SpellingParams {
  /** Log-probability cost of one edit. */
  lambda: number;
  /** Dirichlet prior weight towards the unigram distribution. */
  mu: number;
  /** A word must appear this often to be offered as a correction. */
  minCount: number;
  /** The score of leaving an unknown word as written: a correction must beat it. */
  keep: number;
}

export interface SpellingModel {
  words: string[];
  counts: number[];
  /** "previous next" → count; only pairs seen at least twice. */
  bigrams: Map<string, number>;
  total: number;
  params: SpellingParams;
}

export function trainSpelling(documents: readonly string[], params: SpellingParams): SpellingModel {
  const counts = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const d of documents) {
    const words = tokenize(d);
    for (let i = 0; i < words.length; i++) {
      const w = words[i] ?? '';
      counts.set(w, (counts.get(w) ?? 0) + 1);
      if (i > 0) {
        const key = `${words[i - 1] ?? ''} ${w}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  const kept = [...counts]
    .filter(([w, c]) => c >= params.minCount && /\p{L}/u.test(w))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = kept.reduce((s, [, c]) => s + c, 0);
  return {
    words: kept.map(([w]) => w),
    counts: kept.map(([, c]) => c),
    bigrams: new Map([...pairs].filter(([, c]) => c >= 2)),
    total,
    params,
  };
}

/** Every string reachable by deleting up to `distance` characters (the word itself included). */
export function deletes(word: string, distance: number): Set<string> {
  const out = new Set([word]);
  let frontier = [word];
  for (let d = 0; d < distance; d++) {
    const next: string[] = [];
    for (const w of frontier) {
      const chars = letters(w);
      for (let i = 0; i < chars.length; i++) {
        const shorter = chars.slice(0, i).join('') + chars.slice(i + 1).join('');
        if (!out.has(shorter)) {
          out.add(shorter);
          next.push(shorter);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** Optimal string alignment distance, stopping early once it must exceed `max`. */
export function editDistance(a: string, b: string, max = MAX_DISTANCE): number {
  return lettersDistance(letters(a), letters(b), max);
}

function lettersDistance(x: readonly string[], y: readonly string[], max: number): number {
  if (Math.abs(x.length - y.length) > max) return max + 1;
  const rows = x.length + 1;
  const cols = y.length + 1;
  const d = new Array<number>(rows * cols).fill(0);
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min(
        valueAt(d, (i - 1) * cols + j) + 1,
        valueAt(d, i * cols + j - 1) + 1,
        valueAt(d, (i - 1) * cols + j - 1) + cost,
      );
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1])
        v = Math.min(v, valueAt(d, (i - 2) * cols + j - 2) + 1);
      d[i * cols + j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[rows * cols - 1] ?? max + 1;
}

export interface Speller {
  /** The best correction for `word` after `previous`, or null to leave it alone. */
  correct(word: string, previous: string | null): string | null;
  /** The best-scoring candidate whether or not it beats `keep` (for tuning `keep`). */
  candidate(word: string, previous: string | null): { word: string; score: number } | null;
  /** Corrections for every complete word of a draft (never the last, which may be half-typed). */
  correctDraft(text: string): Array<{ from: string; to: string }>;
  readonly model: SpellingModel;
}

/** The symmetric-delete index: built once per vocabulary, shared by every (λ, μ) tried on it. */
export interface SpellingIndex {
  /** Deletion → the words it comes from: one word as a number, more as a list (most keys have one). */
  deletes: Map<string, number | number[]>;
  id: Map<string, number>;
}

const prefixOf = (word: string) => letters(word).slice(0, PREFIX_LENGTH).join('');

/** A few hundred milliseconds for 20,000 words; lookups are then a handful of hash reads. */
export function buildIndex(words: readonly string[]): SpellingIndex {
  const index = new Map<string, number | number[]>();
  const id = new Map<string, number>();
  words.forEach((w, i) => {
    id.set(w, i);
    if (letters(w).length > MAX_LENGTH) return;
    for (const del of deletes(prefixOf(w), MAX_DISTANCE)) {
      const list = index.get(del);
      if (list === undefined) index.set(del, i);
      else if (typeof list === 'number') index.set(del, [list, i]);
      else list.push(i);
    }
  });
  return { deletes: index, id };
}

/** `built` must come from this model's words; it saves rebuilding when only the parameters differ. */
export function speller(model: SpellingModel, built: SpellingIndex = buildIndex(model.words)): Speller {
  const { deletes: index, id } = built;
  const { lambda, mu } = model.params;
  const unigram = (i: number) => ((model.counts[i] ?? 0) + 1) / (model.total + model.words.length);
  const score = (candidate: number, previous: string | null, edits: number) => {
    const word = model.words[candidate] ?? '';
    const pUni = unigram(candidate);
    const prevId = previous === null ? undefined : id.get(previous);
    const p =
      prevId === undefined
        ? pUni
        : ((model.bigrams.get(`${previous ?? ''} ${word}`) ?? 0) + mu * pUni) / ((model.counts[prevId] ?? 0) + mu);
    return Math.log(p) - lambda * edits;
  };
  const candidate = (word: string, previous: string | null) => {
    const chars = letters(word);
    if (chars.length < MIN_LENGTH || chars.length > MAX_LENGTH || !WORD.test(word) || id.has(word)) return null;
    let best: { i: number; s: number } | null = null;
    const seen = new Set<number>();
    for (const del of deletes(chars.slice(0, PREFIX_LENGTH).join(''), MAX_DISTANCE)) {
      const found = index.get(del);
      for (const i of typeof found === 'number' ? [found] : (found ?? [])) {
        if (seen.has(i)) continue;
        seen.add(i);
        const edits = lettersDistance(chars, letters(model.words[i] ?? ''), MAX_DISTANCE);
        if (edits > MAX_DISTANCE) continue;
        const s = score(i, previous, edits);
        if (!best || s > best.s || (s === best.s && i < best.i)) best = { i, s };
      }
    }
    return best ? { word: model.words[best.i] ?? '', score: best.s } : null;
  };
  const correct = (word: string, previous: string | null): string | null => {
    const best = candidate(word, previous);
    return best && best.score > model.params.keep ? best.word : null;
  };
  return {
    model,
    correct,
    candidate,
    correctDraft(text) {
      const words = tokenize(text);
      // The last word is complete only when something follows it.
      const complete = /[\p{L}\p{M}\p{N}]$/u.test(text) ? words.length - 1 : words.length;
      const out: Array<{ from: string; to: string }> = [];
      // Context is the previous word as corrected: "cusotms dity" means "customs duty".
      let previous: string | null = null;
      for (let i = 0; i < complete; i++) {
        const w = words[i] ?? '';
        const to = correct(w, previous);
        if (to && to !== w) out.push({ from: w, to });
        previous = to ?? w;
      }
      return out;
    },
  };
}

/** The speller the precheck asks, replaced in place when a new version is promoted. */
export function swappableSpeller(): {
  speller: Pick<Speller, 'correctDraft'>;
  set(next: Speller | null): void;
} {
  let inner: Speller | null = null;
  return {
    speller: { correctDraft: text => inner?.correctDraft(text) ?? [] },
    set(next) {
      inner = next;
    },
  };
}

// The artifact: plain JSON, since it holds only words and counts.
export function serializeSpelling(model: SpellingModel): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      words: model.words,
      counts: model.counts,
      bigrams: [...model.bigrams],
      total: model.total,
      params: model.params,
    }),
    'utf8',
  );
}

export function deserializeSpelling(buffer: Buffer): SpellingModel {
  const raw = JSON.parse(buffer.toString('utf8')) as {
    v: number;
    words: string[];
    counts: number[];
    bigrams: Array<[string, number]>;
    total: number;
    params: SpellingParams;
  };
  if (raw.v !== 1 || raw.words.length !== raw.counts.length || !Number.isFinite(raw.params.keep))
    throw new Error('not a Graphinity spelling artifact');
  return { words: raw.words, counts: raw.counts, bigrams: new Map(raw.bigrams), total: raw.total, params: raw.params };
}
