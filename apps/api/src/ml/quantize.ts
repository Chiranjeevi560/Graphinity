// Shrinking meaning vectors (master charter §1.1). SQ8 turns each float into one byte per dimension. PQ (Jégou et al.
// 2011) splits a vector into parts and stores the nearest of 256 learned codes for each. Both trade recall for memory;
// benchmark-quantization measures how much against the halfvec that serves today (ADR 0032).
import { at } from './num.ts';
import { seededRandom } from './linalg.ts';

export interface Sq8 {
  low: Float32Array;
  step: Float32Array;
}

export function trainSq8(vectors: readonly Float32Array[]): Sq8 {
  const d = vectors[0]?.length ?? 0;
  const low = new Float32Array(d).fill(Infinity);
  const high = new Float32Array(d).fill(-Infinity);
  for (const v of vectors)
    for (let i = 0; i < d; i++) {
      const x = at(v, i);
      if (x < at(low, i)) low[i] = x;
      if (x > at(high, i)) high[i] = x;
    }
  const step = new Float32Array(d);
  for (let i = 0; i < d; i++) step[i] = (at(high, i) - at(low, i)) / 255 || 1;
  return { low, step };
}

export function encodeSq8(m: Sq8, v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++)
    out[i] = Math.max(0, Math.min(255, Math.round((at(v, i) - at(m.low, i)) / (m.step[i] ?? 1))));
  return out;
}

/** Inner product of a query with an encoded vector. */
export function scoreSq8(m: Sq8, query: Float32Array, code: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < query.length; i++) sum += at(query, i) * (at(m.low, i) + at(code, i) * (m.step[i] ?? 1));
  return sum;
}

export interface Pq {
  parts: number;
  width: number;
  /** parts × 256 × width. */
  codebook: Float32Array;
}

const CODES = 256;

/** k-means per part. `d` must divide evenly by `parts`. */
export function trainPq(vectors: readonly Float32Array[], parts: number, rounds = 12, seed = 1): Pq {
  const d = vectors[0]?.length ?? 0;
  if (d % parts) throw new Error('vector length must divide evenly by parts');
  const width = d / parts;
  const random = seededRandom(seed);
  const codebook = new Float32Array(parts * CODES * width);
  for (let p = 0; p < parts; p++) {
    const slot = p * CODES * width;
    for (let c = 0; c < CODES; c++) {
      const from = vectors[Math.floor(random() * vectors.length)];
      for (let i = 0; i < width; i++) codebook[slot + c * width + i] = from?.[p * width + i] ?? 0;
    }
    for (let round = 0; round < rounds; round++) {
      const sums = new Float64Array(CODES * width);
      const counts = new Int32Array(CODES);
      for (const v of vectors) {
        const c = nearestCode(codebook, slot, v, p * width, width);
        counts[c] = at(counts, c) + 1;
        for (let i = 0; i < width; i++) sums[c * width + i] = at(sums, c * width + i) + at(v, p * width + i);
      }
      for (let c = 0; c < CODES; c++) {
        const count = at(counts, c);
        if (count) for (let i = 0; i < width; i++) codebook[slot + c * width + i] = at(sums, c * width + i) / count;
      }
    }
  }
  return { parts, width, codebook };
}

function nearestCode(book: Float32Array, slot: number, v: Float32Array, from: number, width: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let c = 0; c < CODES; c++) {
    let distance = 0;
    for (let i = 0; i < width; i++) {
      const gap = at(v, from + i) - at(book, slot + c * width + i);
      distance += gap * gap;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return best;
}

export function encodePq(m: Pq, v: Float32Array): Uint8Array {
  const out = new Uint8Array(m.parts);
  for (let p = 0; p < m.parts; p++) out[p] = nearestCode(m.codebook, p * CODES * m.width, v, p * m.width, m.width);
  return out;
}

/** The query's inner product with every code, so scoring a vector is a table lookup per part. */
export function pqTable(m: Pq, query: Float32Array): Float32Array {
  const table = new Float32Array(m.parts * CODES);
  for (let p = 0; p < m.parts; p++)
    for (let c = 0; c < CODES; c++) {
      let sum = 0;
      const slot = p * CODES * m.width + c * m.width;
      for (let i = 0; i < m.width; i++) sum += at(query, p * m.width + i) * at(m.codebook, slot + i);
      table[p * CODES + c] = sum;
    }
  return table;
}

export function scorePq(m: Pq, table: Float32Array, code: Uint8Array): number {
  let sum = 0;
  for (let p = 0; p < m.parts; p++) sum += at(table, p * CODES + at(code, p));
  return sum;
}
