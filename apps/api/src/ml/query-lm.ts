// Graphinity's own language model for finishing what someone types into search: a word trigram model with
// interpolated Kneser-Ney smoothing (Chen & Goodman 1998), trained only on public question titles. It completes
// phrasing people already used; it never writes an answer (CLAUDE.md: no AI-written answers) and it isn't a
// generative LLM (the owner's decision, 2026-10-26). A word sequence is suggested only once it appears in
// MIN_QUESTIONS different questions, so one person's unusual wording is never echoed to someone else.
export const MIN_QUESTIONS = 3;
const DISCOUNT = 0.75;
const START = '<s>';
const END = '</s>';

export interface QueryLm {
  /** Count of each trigram, bigram and unigram, keyed by words joined with a space. */
  tri: Map<string, number>;
  bi: Map<string, number>;
  uni: Map<string, number>;
  /** How many distinct questions each bigram and trigram appeared in: the floor for suggesting it. */
  questions: Map<string, number>;
  /** Kneser-Ney continuation counts: distinct words before a word, and distinct (before, word) pairs. */
  continuation: Map<string, number>;
  continuationTotal: number;
  /** Distinct words seen after a context, for the back-off weight. */
  followers: Map<string, Set<string>>;
  /** Total count of each context, for normalising. */
  contexts: Map<string, number>;
}

export function tokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(' ')
    .filter(w => w.length > 0 && w.length <= 30);
}

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export function trainQueryLm(titles: readonly string[]): QueryLm {
  const lm: QueryLm = {
    tri: new Map(),
    bi: new Map(),
    uni: new Map(),
    questions: new Map(),
    continuation: new Map(),
    continuationTotal: 0,
    followers: new Map(),
    contexts: new Map(),
  };
  const pairsBefore = new Map<string, Set<string>>();
  for (const title of titles) {
    const words = [START, START, ...tokens(title), END];
    const seen = new Set<string>();
    for (let i = 2; i < words.length; i++) {
      const [a, b, c] = [words[i - 2] ?? START, words[i - 1] ?? START, words[i] ?? END];
      bump(lm.tri, `${a} ${b} ${c}`);
      bump(lm.bi, `${b} ${c}`);
      bump(lm.uni, c);
      bump(lm.contexts, `${a} ${b}`);
      bump(lm.contexts, b);
      const after2 = lm.followers.get(`${a} ${b}`) ?? new Set<string>();
      lm.followers.set(`${a} ${b}`, after2.add(c));
      const after1 = lm.followers.get(b) ?? new Set<string>();
      lm.followers.set(b, after1.add(c));
      const before = pairsBefore.get(c) ?? new Set<string>();
      pairsBefore.set(c, before.add(b));
      seen.add(`${b} ${c}`).add(`${a} ${b} ${c}`);
    }
    for (const k of seen) bump(lm.questions, k);
  }
  for (const [word, before] of pairsBefore) lm.continuation.set(word, before.size);
  lm.continuationTotal = [...lm.continuation.values()].reduce((a, b) => a + b, 0);
  return lm;
}

/** P(word | a b), interpolated Kneser-Ney down to the continuation unigram. */
export function probability(lm: QueryLm, a: string, b: string, word: string): number {
  const vocabulary = Math.max(1, lm.continuation.size);
  const unigram = ((lm.continuation.get(word) ?? 0) + 1) / (lm.continuationTotal + vocabulary);
  const level = (context: string, count: number) => {
    const total = lm.contexts.get(context) ?? 0;
    if (!total) return null;
    const followers = lm.followers.get(context)?.size ?? 0;
    return { first: Math.max(count - DISCOUNT, 0) / total, weight: (DISCOUNT * followers) / total };
  };
  const bi = level(b, lm.bi.get(`${b} ${word}`) ?? 0);
  const pBi = bi ? bi.first + bi.weight * unigram : unigram;
  const tri = level(`${a} ${b}`, lm.tri.get(`${a} ${b} ${word}`) ?? 0);
  return tri ? tri.first + tri.weight * pBi : pBi;
}

/** Per-word perplexity of `titles` under the model: lower is better. */
export function perplexity(lm: QueryLm, titles: readonly string[]): number {
  let logSum = 0;
  let n = 0;
  for (const title of titles) {
    const words = [START, START, ...tokens(title), END];
    for (let i = 2; i < words.length; i++) {
      logSum += Math.log(probability(lm, words[i - 2] ?? START, words[i - 1] ?? START, words[i] ?? END));
      n += 1;
    }
  }
  return n ? Math.exp(-logSum / n) : Infinity;
}

/**
 * Up to `k` ways to finish what was typed: the last word completed if it is partial, then up to `extra` more words,
 * each step the likeliest word whose sequence passed the floor. Nothing below the floor is ever suggested.
 */
export function complete(lm: QueryLm, typed: string, k = 5, extra = 3): string[] {
  const words = tokens(typed);
  if (!words.length) return [];
  const partial = /\s$/.test(typed) ? '' : (words.pop() ?? '');
  const context = [START, START, ...words];
  const allowed = (a: string, b: string, c: string) =>
    (lm.questions.get(`${a} ${b} ${c}`) ?? 0) >= MIN_QUESTIONS ||
    (a === START && (lm.questions.get(`${b} ${c}`) ?? 0) >= MIN_QUESTIONS);
  const next = (ctx: string[], prefix: string) => {
    const a = ctx[ctx.length - 2] ?? START;
    const b = ctx[ctx.length - 1] ?? START;
    return [...(lm.followers.get(`${a} ${b}`) ?? [])]
      .filter(w => w !== END && w.startsWith(prefix) && allowed(a, b, w))
      .map(w => ({ w, p: probability(lm, a, b, w) }))
      .sort((x, y) => y.p - x.p || (x.w < y.w ? -1 : 1));
  };
  const out: string[] = [];
  for (const { w } of next(context, partial).slice(0, k)) {
    const phrase = [...context, w];
    for (let step = 0; step < extra; step++) {
      const best = next(phrase, '')[0];
      if (!best) break;
      phrase.push(best.w);
    }
    out.push(phrase.slice(2).join(' '));
  }
  return out;
}
