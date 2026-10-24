// Okapi BM25 (Robertson & Zaragoza 2009), the standard for ranking by words:
// what a model must beat before Graphinity trusts it over plain matching.
// k1 = 1.2 and b = 0.75 are the textbook values Lucene and Elasticsearch ship.
import { tokenize } from './text-embedding.ts';

const K1 = 1.2;
const B = 0.75;

export interface Bm25Index {
  score(query: string, docIndex: number): number;
  readonly size: number;
}

export function bm25Index(documents: readonly string[]): Bm25Index {
  const docs = documents.map(d => {
    const tf = new Map<string, number>();
    const words = tokenize(d);
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { tf, length: words.length };
  });
  const n = docs.length;
  const avgLength = n ? docs.reduce((s, d) => s + d.length, 0) / n : 0;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  // Lucene's idf: log(1 + (N - df + 0.5) / (df + 0.5)), never negative.
  const idf = (w: string) => {
    const f = df.get(w) ?? 0;
    return Math.log(1 + (n - f + 0.5) / (f + 0.5));
  };
  return {
    size: n,
    score(query, docIndex) {
      const d = docs[docIndex];
      if (!d) return 0;
      let s = 0;
      for (const w of new Set(tokenize(query))) {
        const f = d.tf.get(w) ?? 0;
        if (f === 0) continue;
        s += (idf(w) * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.length) / (avgLength || 1)));
      }
      return s;
    },
  };
}
