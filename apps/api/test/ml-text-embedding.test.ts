import { describe, expect, it } from 'vitest';
import {
  deserializeModel,
  embedText,
  serializeModel,
  tokenize,
  trainTextEmbedding,
  type TextEmbeddingModel,
} from '../src/ml/text-embedding.ts';

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};

const wordVector = (m: TextEmbeddingModel, w: string) => {
  const i = m.vocab.indexOf(w);
  if (i < 0) throw new Error(`${w} not in vocabulary`);
  return m.vectors.subarray(i * m.dims, (i + 1) * m.dims);
};

/**
 * A corpus where "duty" and "tax" are used in the same kinds of sentences and
 * never together, as synonyms are, and "visa"/"permit" likewise in another
 * topic. Distributional learning must find each pair closer than across.
 */
function corpus(): string[] {
  const goods = ['watch', 'camera', 'laptop', 'phone', 'perfume', 'bicycle'];
  const places = ['dubai', 'chennai', 'delhi', 'singapore', 'mumbai'];
  const docs: string[] = [];
  for (const g of goods)
    for (const p of places) {
      docs.push(`how much customs duty did you pay importing a ${g} through ${p} airport`);
      docs.push(`what import tax applies to a ${g} shipped to ${p} by courier`);
      docs.push(`is there customs duty on a used ${g} arriving at ${p}`);
      docs.push(`the import tax on my ${g} at ${p} was charged on the invoice value`);
    }
  for (const p of places)
    for (const job of ['nurse', 'engineer', 'teacher', 'chef']) {
      docs.push(`how long did your work visa take as a ${job} moving to ${p}`);
      docs.push(`which documents did the work permit need for a ${job} in ${p}`);
      docs.push(`my visa interview for ${p} asked about my ${job} contract`);
      docs.push(`the permit office in ${p} wanted my ${job} degree attested`);
    }
  return docs;
}

describe('training', () => {
  const model = trainTextEmbedding(corpus(), { dims: 16, seed: 1 });

  it('learns that words used the same way mean similar things', () => {
    const duty = wordVector(model, 'duty');
    const tax = wordVector(model, 'tax');
    const visa = wordVector(model, 'visa');
    const permit = wordVector(model, 'permit');
    expect(dot(duty, tax)).toBeGreaterThan(dot(duty, visa));
    expect(dot(duty, tax)).toBeGreaterThan(dot(duty, permit));
    expect(dot(visa, permit)).toBeGreaterThan(dot(visa, tax));
  });

  it('puts a question asked in other words nearer than a question on another topic', () => {
    const asked = embedText(model, 'customs duty on a watch at chennai');
    const reworded = embedText(model, 'import tax for a watch in chennai');
    const other = embedText(model, 'work visa for a chef in chennai');
    expect(dot(asked, reworded)).toBeGreaterThan(dot(asked, other));
  });

  it('gives unit vectors, and all zeros for text with no words', () => {
    const v = embedText(model, 'customs duty on a phone');
    expect(Math.sqrt(dot(v, v))).toBeCloseTo(1, 6);
    expect([...embedText(model, '!!! ???')].every(x => x === 0)).toBe(true);
  });

  it('still matches a word it never saw, against itself', () => {
    const a = embedText(model, 'form BOE-II for a watch');
    const b = embedText(model, 'BOE-II needed?');
    const c = embedText(model, 'form for a watch');
    expect(dot(a, b)).toBeGreaterThan(dot(c, b));
  });

  it('is reproducible: the same corpus and seed give the same model', () => {
    const again = trainTextEmbedding(corpus(), { dims: 16, seed: 1 });
    expect(again.vocab).toEqual(model.vocab);
    expect([...again.vectors]).toEqual([...model.vectors]);
  });

  it('refuses a corpus too small to learn from', () => {
    expect(() => trainTextEmbedding(['one'])).toThrow(/not enough distinct words/);
  });
});

describe('the artifact', () => {
  it('round-trips exactly and refuses anything else', () => {
    const model = trainTextEmbedding(corpus(), { dims: 8, seed: 2 });
    const back = deserializeModel(serializeModel(model));
    expect(back.vocab).toEqual(model.vocab);
    expect([...back.vectors]).toEqual([...model.vectors]);
    expect([...embedText(back, 'customs duty')]).toEqual([...embedText(model, 'customs duty')]);
    expect(() => deserializeModel(Buffer.from('nope'))).toThrow(/not a Graphinity/);
    const cut = serializeModel(model).subarray(0, 100);
    expect(() => deserializeModel(Buffer.from(cut))).toThrow();
  });
});

describe('tokenize', () => {
  it('keeps words in Indian scripts whole: vowel signs are combining marks, part of the word', () => {
    expect(tokenize('తెలుగులో కస్టమ్స్ డ్యూటీ ఎంత?')).toEqual(['తెలుగులో', 'కస్టమ్స్', 'డ్యూటీ', 'ఎంత']);
    expect(tokenize('हिंदी में कस्टम ड्यूटी')).toEqual(['हिंदी', 'में', 'कस्टम', 'ड्यूटी']);
  });

  it('splits on anything that is not a letter or digit, in any script, lowercased', () => {
    expect(tokenize('Customs: ₹95,000 at Chennai — BOE-II? 日本')).toEqual([
      'customs',
      '95',
      '000',
      'at',
      'chennai',
      'boe',
      'ii',
      '日本',
    ]);
  });
});
