// Nothing is said unless a person said it (master charter §10.2; product rule: no
// AI-written answers). Each sentence of a summary must be entailed by a cited human
// answer, or it's dropped. Entailment is lexical-numeric: content words covered
// (with a light stem), and every number and negation must agree. This errs toward
// dropping: a false "no" loses a sentence, a false "yes" would invent a fact.
import { sentencesOf } from './claims.ts';

export const ENTAILMENT_MIN = 0.75;
const STOP = new Set(
  'a an the is are was were be been of to in on at for and or but if it its this that with as by from i you we they he she their my our your have has had will would can could do does did so than then there'.split(
    ' ',
  ),
);
const NEGATION = /\b(not|no|never|none|cannot|can't|won't|didn't|doesn't|isn't|aren't|wasn't|without)\b/i;
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/u, '');
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(w => w && !STOP.has(w) && !/\d/.test(w))
    .map(stem);
const numbers = (s: string) => s.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? [];

export function entailment(premise: string, hypothesis: string): number {
  const nums = numbers(hypothesis);
  const have = new Set(numbers(premise));
  if (nums.some(n => !have.has(n))) return 0;
  if (NEGATION.test(hypothesis) !== NEGATION.test(premise)) return 0;
  const h = words(hypothesis);
  if (h.length === 0) return nums.length > 0 ? 1 : 0;
  const p = new Set(words(premise));
  return h.filter(w => p.has(w)).length / h.length;
}

export interface Verified {
  kept: Array<{ sentence: string; source: string; score: number }>;
  dropped: string[];
}

export function verifyFaithfulness(summary: string, sources: ReadonlyArray<{ id: string; text: string }>): Verified {
  const kept: Verified['kept'] = [];
  const dropped: string[] = [];
  for (const sentence of sentencesOf(summary)) {
    let best = { score: 0, source: '' };
    for (const s of sources)
      for (const premise of sentencesOf(s.text)) {
        const score = entailment(premise, sentence);
        if (score > best.score) best = { score, source: s.id };
      }
    if (best.score >= ENTAILMENT_MIN) kept.push({ sentence, ...best });
    else dropped.push(sentence);
  }
  return { kept, dropped };
}
