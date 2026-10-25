// Synthetic questions shaped like Graphinity's, shared by the benchmarks:
// question details paraphrase their title with synonyms ("duty" / "tax" /
// "levy"), which word matching can't connect. Says how methods scale and
// whether paraphrase can be learned from co-occurrence; it does not predict
// quality on real posts.
import { seededRandom } from '../../apps/api/src/ml/linalg.ts';

const SYNONYMS = [
  ['duty', 'tax', 'levy'],
  ['import', 'bring', 'ship'],
  ['visa', 'permit', 'authorisation'],
  ['rent', 'lease', 'tenancy'],
  ['repair', 'service', 'fix'],
  ['price', 'cost', 'charge'],
];
const TOPICS = [
  {
    s: 0,
    title: (g, p) => `customs DUTY on a ${g} at ${p}`,
    body: (g, p, w) => `what ${w} did you pay when your ${g} arrived at ${p} airport`,
  },
  {
    s: 1,
    title: (g, p) => `how to IMPORT a ${g} into ${p}`,
    body: (g, p, w) => `what paperwork did you need to ${w} your ${g} into ${p}`,
  },
  {
    s: 2,
    title: (g, p) => `work VISA for a ${g} seller in ${p}`,
    body: (g, p, w) => `how long did your ${w} take to sell ${g} goods in ${p}`,
  },
  {
    s: 3,
    title: (g, p) => `shop RENT for a ${g} store in ${p}`,
    body: (g, p, w) => `what ${w} terms did you get for a ${g} store in ${p}`,
  },
  {
    s: 4,
    title: (g, p) => `${g} REPAIR shops in ${p}`,
    body: (g, p, w) => `where did you get your ${g} to ${w} in ${p} and was it good`,
  },
  {
    s: 5,
    title: (g, p) => `${g} PRICE at markets in ${p}`,
    body: (g, p, w) => `what ${w} did you see for a ${g} at markets in ${p}`,
  },
];

/**
 * Zipf-distributed filler from a 20,000-word lexicon (real text's word
 * frequencies fall off as 1/rank), 2,000 products and 500 places, so many
 * questions share a product and place and differ only in topic: the case
 * where word matching confuses one question with another.
 */
export function corpus(size, seed = 1) {
  const r = seededRandom(seed);
  const lexicon = 20_000;
  // Inverse-CDF sampling of Zipf(1) over the lexicon.
  const harmonic = Array.from({ length: lexicon }, (_, i) => 1 / (i + 1));
  const cdf = [];
  harmonic.reduce((sum, x, i) => (cdf[i] = sum + x), 0);
  const total = cdf[lexicon - 1];
  const filler = () => {
    const u = r() * total;
    let lo = 0;
    let hi = lexicon - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return `w${lo}`;
  };
  const words = n => Array.from({ length: n }, filler).join(' ');
  const goods = Array.from({ length: 2000 }, (_, i) => `item${i}`);
  const places = Array.from({ length: 500 }, (_, i) => `city${i}`);
  const questions = [];
  for (let id = 1; id <= size; id++) {
    const t = TOPICS[Math.floor(r() * TOPICS.length)];
    const g = goods[Math.floor(r() * goods.length)];
    const p = places[Math.floor(r() * places.length)];
    const [first, ...others] = SYNONYMS[t.s];
    // Title uses the topic's main word; the details another word for it.
    const w = others[Math.floor(r() * others.length)];
    questions.push({
      id: String(id),
      title: `${t.title(g, p).replace(/[A-Z]+/, first)} ${words(2)}`,
      body: `${t.body(g, p, w)} ${words(6)}`,
    });
  }
  return questions;
}
