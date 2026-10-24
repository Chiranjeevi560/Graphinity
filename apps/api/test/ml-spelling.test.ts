import { describe, expect, it } from 'vitest';
import {
  decideSpelling,
  evaluateSpelling,
  MIN_CHANGES,
  MIN_TYPOS,
  preferred,
  sweepKeep,
  testWords,
  tune,
  wilsonLower,
  type SpellingScores,
} from '../src/ml/spelling-gate.ts';
import { seededRandom } from '../src/ml/linalg.ts';
import {
  buildIndex,
  deletes,
  deserializeSpelling,
  editDistance,
  letters,
  MIN_LENGTH,
  PREFIX_LENGTH,
  serializeSpelling,
  speller,
  trainSpelling,
} from '../src/ml/spelling.ts';

// keep −1000: any candidate within two edits beats leaving the word as written.
const params = { lambda: 4, mu: 5, minCount: 2, keep: -1000 };

describe('letters and distance', () => {
  it('counts letters as people see them, so an Indian-script vowel sign stays with its consonant', () => {
    expect(letters('duty')).toEqual(['d', 'u', 't', 'y']);
    expect(letters('డ్యూటీ')).toEqual(['డ్యూ', 'టీ']);
  });

  it('measures edits with adjacent swaps as one, and stops early past the limit', () => {
    expect(editDistance('duty', 'duty')).toBe(0);
    expect(editDistance('cusotms', 'customs')).toBe(1);
    expect(editDistance('dty', 'duty')).toBe(1);
    expect(editDistance('dutey', 'duty')).toBe(1);
    expect(editDistance('dxtx', 'duty')).toBe(2);
    expect(editDistance('abcdef', 'uvwxyz')).toBe(3);
    expect(editDistance('a', 'abcdef')).toBe(3);
  });

  it('lists every deletion up to the distance, the word included', () => {
    expect([...deletes('abc', 1)].sort()).toEqual(['ab', 'abc', 'ac', 'bc']);
    expect(deletes('abc', 2).has('a')).toBe(true);
  });
});

/** "duty" after "customs", "dirty" after "very": the same typo, two right answers. */
function corpus(): string[] {
  const docs: string[] = [];
  for (let i = 0; i < 20; i++) {
    docs.push('how much customs duty did you pay on the watch');
    docs.push('the road was very dirty after the monsoon rains');
    docs.push('customs officers checked the invoice and the passport and the certificate');
  }
  return docs;
}

describe('the index', () => {
  it('finds every word within two edits that a full scan of the vocabulary finds', () => {
    const random = seededRandom(3);
    const alphabet = 'abcdeirstu';
    const word = (n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const vocabulary = [...new Set(Array.from({ length: 800 }, () => word(4 + Math.floor(random() * 10))))];
    const built = buildIndex(vocabulary);
    let checked = 0;
    for (let t = 0; t < 200; t++) {
      // Typos of known words (most within reach) and random strings (mostly not).
      const base = vocabulary[Math.floor(random() * vocabulary.length)] ?? '';
      const chars = letters(base);
      for (let e = 0, k = 1 + Math.floor(random() * 2); e < k; e++) {
        const i = Math.floor(random() * chars.length);
        const op = Math.floor(random() * 3);
        if (op === 0) chars.splice(i, 1);
        else if (op === 1) chars.splice(i, 0, alphabet[Math.floor(random() * alphabet.length)] ?? 'a');
        else chars[i] = alphabet[Math.floor(random() * alphabet.length)] ?? 'a';
      }
      for (const query of [chars.join(''), word(4 + Math.floor(random() * 10))]) {
        if (query.length < MIN_LENGTH) continue;
        const scan = vocabulary.filter(v => editDistance(query, v) <= 2).sort();
        const looked = new Set<number>();
        for (const del of deletes(letters(query).slice(0, PREFIX_LENGTH).join(''), 2)) {
          const found = built.deletes.get(del);
          for (const i of typeof found === 'number' ? [found] : (found ?? [])) looked.add(i);
        }
        const viaIndex = [...looked]
          .map(i => vocabulary[i] ?? '')
          .filter(v => editDistance(query, v) <= 2)
          .sort();
        expect(viaIndex).toEqual(scan);
        checked += scan.length;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe('the speller', () => {
  const s = speller(trainSpelling(corpus(), params));

  it('fixes a typo into a word the corpus uses', () => {
    expect(s.correct('cusotms', null)).toBe('customs');
    expect(s.correct('pasport', 'the')).toBe('passport');
    // A long word with the typo past the indexed prefix.
    expect(s.correct('certificaet', 'the')).toBe('certificate');
  });

  it('lets the previous word decide between equally close corrections', () => {
    expect(s.correct('dity', 'customs')).toBe('duty');
    expect(s.correct('dity', 'very')).toBe('dirty');
  });

  it('leaves alone known words, short words, codes and numbers, and what it can’t place', () => {
    expect(s.correct('customs', null)).toBeNull();
    expect(s.correct('dty', null)).toBeNull();
    expect(s.correct('boe2', null)).toBeNull();
    expect(s.correct('duty1', null)).toBeNull();
    expect(s.correct('zzzzzzzz', null)).toBeNull();
  });

  it('leaves a word as written when no correction scores above keep', () => {
    const cautious = speller(trainSpelling(corpus(), { ...params, keep: 0 }));
    expect(cautious.candidate('cusotms', null)).toMatchObject({ word: 'customs' });
    expect(cautious.correct('cusotms', null)).toBeNull();
    const score = cautious.candidate('cusotms', null)?.score ?? 0;
    expect(speller(trainSpelling(corpus(), { ...params, keep: score - 0.01 })).correct('cusotms', null)).toBe(
      'customs',
    );
    expect(speller(trainSpelling(corpus(), { ...params, keep: score })).correct('cusotms', null)).toBeNull();
  });

  it('corrects the words of a draft, but not the last one until something follows it', () => {
    expect(s.correctDraft('how much cusotms dity')).toEqual([{ from: 'cusotms', to: 'customs' }]);
    expect(s.correctDraft('how much cusotms dity ')).toEqual([
      { from: 'cusotms', to: 'customs' },
      { from: 'dity', to: 'duty' },
    ]);
    expect(s.correctDraft('cusotms dity?')).toEqual([
      { from: 'cusotms', to: 'customs' },
      { from: 'dity', to: 'duty' },
    ]);
  });

  it('fixes a typo inside a Telugu word, letter by letter', () => {
    const telugu = speller(
      trainSpelling(
        Array.from({ length: 10 }, () => 'కస్టమ్స్ డ్యూటీ ఎంత చెల్లించాలి'),
        params,
      ),
    );
    // One letter, a consonant with its vowel sign, written wrong: one edit, not two.
    expect(letters('చెల్లించాలి')).toHaveLength(4);
    expect(editDistance('చెల్లించాలా', 'చెల్లించాలి')).toBe(1);
    expect(telugu.correct('చెల్లించాలా', 'ఎంత')).toBe('చెల్లించాలి');
  });

  it('round-trips its artifact and refuses anything else', () => {
    const model = trainSpelling(corpus(), params);
    const back = deserializeSpelling(serializeSpelling(model));
    expect(speller(back).correct('cusotms', null)).toBe('customs');
    expect(back.bigrams.size).toBe(model.bigrams.size);
    const bad = JSON.parse(serializeSpelling(model).toString()) as { params: { keep: unknown } };
    bad.params.keep = null;
    expect(() => deserializeSpelling(Buffer.from(JSON.stringify(bad)))).toThrow(/not a Graphinity/);
    expect(() => deserializeSpelling(Buffer.from(JSON.stringify({ v: 2, words: [], counts: [] })))).toThrow(
      /not a Graphinity/,
    );
  });
});

describe('the spelling gate', () => {
  it('computes Wilson’s lower bound', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(8, 10)).toBeCloseTo(0.4902, 3);
    expect(wilsonLower(95, 100)).toBeCloseTo(0.8882, 3);
  });

  it('makes typos that aren’t words, and new words left as written, split into two halves', () => {
    const vocab = new Set(['customs', 'passport', 'invoice', 'monsoon']);
    const { tune: a, test: b } = testWords(['customs passport invoice monsoon chennai'], vocab, 3);
    const all = [...a, ...b];
    for (const w of all.filter(x => x.kind === 'typo')) {
      expect(vocab.has(w.written)).toBe(false);
      expect(w.written).not.toBe(w.intended);
    }
    expect(all.filter(x => x.kind === 'new').map(x => x.written)).toEqual(['chennai']);
    expect(testWords(['customs passport invoice monsoon chennai'], vocab, 3)).toEqual({ tune: a, test: b });
  });

  const scores = (over: Partial<SpellingScores>): SpellingScores => ({
    typos: 500,
    newWords: 100,
    changed: 400,
    right: 380,
    precision: 0.95,
    precisionLower: 0.92,
    recall: 0.76,
    ...over,
  });

  it('refuses with too few typos, too few changes, or precision under the bar', () => {
    expect(decideSpelling(scores({ typos: MIN_TYPOS - 1 }), null)).toEqual({
      promote: false,
      reason: `only ${String(MIN_TYPOS - 1)} test typos; ${String(MIN_TYPOS)} needed`,
    });
    expect(decideSpelling(scores({ changed: MIN_CHANGES - 1 }), null)).toMatchObject({
      promote: false,
      reason: /changed only/,
    });
    // Right 85% of the time on average, but too few changes to be sure of 80%.
    expect(decideSpelling(scores({ precision: 0.85, precisionLower: 0.75 }), null).promote).toBe(false);
    expect(decideSpelling(scores({ precision: 0.75, precisionLower: 0.7 }), null)).toMatchObject({
      promote: false,
      reason: /bar is 80%/,
    });
  });

  it('refuses to replace a serving version that fixes more typos, and otherwise promotes', () => {
    expect(decideSpelling(scores({ recall: 0.6 }), scores({ recall: 0.7 })).promote).toBe(false);
    expect(decideSpelling(scores({}), scores({ recall: 0.7 })).promote).toBe(true);
    expect(decideSpelling(scores({}), null)).toMatchObject({ promote: true, reason: /fixes 76\.0%/ });
  });

  it('never makes a typo that is itself a word, even when nearly every edit makes one', () => {
    // Every 4-letter string of a and b is a word here, so most substitutions and swaps give a word.
    const vocab = new Set(
      Array.from({ length: 16 }, (_, i) => i.toString(2).padStart(4, '0').replace(/0/g, 'a').replace(/1/g, 'b')),
    );
    const { tune: a, test: b } = testWords([[...vocab].join(' ')], vocab, 5);
    const typos = [...a, ...b].filter(w => w.kind === 'typo');
    for (const w of typos) expect(vocab.has(w.written)).toBe(false);
  });

  it('prefers a setting that clears the bar over one that fixes more but is less sure', () => {
    const sure = scores({ precisionLower: 0.85, recall: 0.5 });
    const eager = scores({ precisionLower: 0.7, recall: 0.9 });
    expect(preferred(sure, eager)).toBe(true);
    expect(preferred(eager, sure)).toBe(false);
    expect(preferred(scores({ recall: 0.8 }), scores({ recall: 0.7 }))).toBe(true);
    expect(preferred(scores({ precisionLower: 0.7 }), scores({ precisionLower: 0.6 }))).toBe(true);
    expect(preferred(scores({ precisionLower: 0.6, recall: 0.9 }), scores({ precisionLower: 0.7 }))).toBe(false);
  });

  it('sweeps keep to the cut with the most fixes that is still sure enough', () => {
    // 60 right fixes score high, then 40 changes that are mostly wrong.
    const scored = [
      ...Array.from({ length: 60 }, (_, i) => ({ score: -10 - i * 0.01, right: true, typo: true })),
      ...Array.from({ length: 40 }, (_, i) => ({ score: -20 - i * 0.01, right: i % 4 === 0, typo: i % 4 === 0 })),
    ];
    const { keep, scores } = sweepKeep(scored, 120, 30);
    expect(scores.changed).toBeGreaterThanOrEqual(60);
    expect(scores.precisionLower).toBeGreaterThanOrEqual(0.8);
    expect(scores.recall).toBeCloseTo(scores.right / 120);
    // Exactly the words above keep are changed.
    expect(scored.filter(x => x.score > keep)).toHaveLength(scores.changed);
    // A tie is never split: both or neither are changed.
    const tied = sweepKeep(
      [
        { score: -5, right: true, typo: true },
        { score: -5, right: false, typo: false },
      ],
      1,
      1,
    );
    expect([0, 2]).toContain(tied.scores.changed);
    expect(sweepKeep([], 0, 0)).toMatchObject({ keep: 0, scores: { changed: 0 } });
  });

  it('tunes λ and μ to clear the bar on a corpus it can learn from', () => {
    const docs = corpus();
    const vocab = new Set(trainSpelling(docs, params).words);
    const { tune: words } = testWords([...docs, ...docs], vocab, 1);
    const best = tune(docs, words);
    expect(best.scores.precisionLower).toBeGreaterThanOrEqual(0.8);
    expect(best.scores.recall).toBeGreaterThan(0);
    expect(evaluateSpelling(trainSpelling(docs, best.params), words)).toEqual(best.scores);
  });
});
