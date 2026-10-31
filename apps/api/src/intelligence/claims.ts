// Empirical claims in human answers (master charter §10.1). The owner decided on no
// generative LLM (2026-10-26), so extraction is deterministic: patterns for money,
// durations and outcomes, then a distilled student (below) that learns to spot
// claim-bearing sentences from these high-precision labels, and runs under 1 ms. A
// teacher LLM could later replace the labels with no change to the student.
import { fitRidge, predictRidge, type RidgeModel } from '../ml/ridge.ts';

export interface Claim {
  metric: 'cost' | 'duration';
  value: number;
  currency?: string;
  days?: number;
  outcome: 'success' | 'failure' | 'unknown';
  sentence: string;
}

const CURRENCY: Readonly<Record<string, string>> = {
  '₹': 'INR',
  rs: 'INR',
  'rs.': 'INR',
  inr: 'INR',
  rupees: 'INR',
  $: 'USD',
  usd: 'USD',
  dollars: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  euros: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
  pounds: 'GBP',
};
const SCALE: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  crore: 1e7,
  crores: 1e7,
  million: 1e6,
  m: 1e6,
};
const UNIT_DAYS: Readonly<Record<string, number>> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  month: 30,
  months: 30,
  year: 365,
  years: 365,
};
const MONEY_BEFORE =
  /(₹|\$|€|£|\brs\.?|\binr\b|\busd\b|\beur\b|\bgbp\b)\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lac|crores?|million|m)?\b/giu;
const MONEY_AFTER =
  /\b([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lac|crores?|million)?\s*(rupees|dollars|euros|pounds|inr|usd|eur|gbp)\b/giu;
const DURATION = /\b(\d+(?:\.\d+)?)\s*(days?|weeks?|months?|years?)\b/gi;
const SUCCESS = /\b(approved|worked|cleared|succeeded|got it|received|accepted|passed|resolved)\b/i;
const FAILURE = /\b(rejected|refused|failed|denied|seized|didn'?t work|did not work|lost|cancelled)\b/i;

export const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?\n])\s+/u)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, 200);

const parseAmount = (raw: string, scale: string | undefined) =>
  Number(raw.replace(/,/g, '')) * (scale ? (SCALE[scale.toLowerCase()] ?? 1) : 1);

export function extractClaims(text: string): Claim[] {
  const out: Claim[] = [];
  for (const sentence of sentencesOf(text)) {
    const outcome = FAILURE.test(sentence) ? 'failure' : SUCCESS.test(sentence) ? 'success' : 'unknown';
    for (const m of sentence.matchAll(MONEY_BEFORE)) {
      const value = parseAmount(m[2] ?? '0', m[3]);
      const currency = CURRENCY[(m[1] ?? '').toLowerCase()];
      if (Number.isFinite(value) && currency) out.push({ metric: 'cost', value, currency, outcome, sentence });
    }
    for (const m of sentence.matchAll(MONEY_AFTER)) {
      const value = parseAmount(m[1] ?? '0', m[2]);
      const currency = CURRENCY[(m[3] ?? '').toLowerCase()];
      if (Number.isFinite(value) && currency) out.push({ metric: 'cost', value, currency, outcome, sentence });
    }
    for (const m of sentence.matchAll(DURATION)) {
      const days = Number(m[1]) * (UNIT_DAYS[(m[2] ?? '').toLowerCase()] ?? 1);
      out.push({ metric: 'duration', value: days, days, outcome, sentence });
    }
  }
  return out;
}

const DIMS = 256;
const featureOf = (sentence: string): number[] => {
  const x = new Array<number>(DIMS).fill(0);
  const words = sentence
    .toLowerCase()
    .replace(/\d+/g, '#')
    .split(/[^\p{L}#]+/u)
    .filter(Boolean);
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    const k = (h >>> 0) % DIMS;
    x[k] = (x[k] ?? 0) + 1;
  }
  const norm = Math.sqrt(x.reduce((a, b) => a + b * b, 0)) || 1;
  return x.map(v => v / norm);
};

/** Trains the student on the teacher's labels over a corpus of sentences. */
export function distillStudent(
  sentences: readonly string[],
  teacher: (s: string) => boolean = s => extractClaims(s).length > 0,
): RidgeModel {
  return fitRidge(
    sentences.map(s => ({ x: featureOf(s), y: teacher(s) ? 1 : 0 })),
    0.5,
  );
}

export const studentScore = (m: RidgeModel, sentence: string) => predictRidge(m, featureOf(sentence));
