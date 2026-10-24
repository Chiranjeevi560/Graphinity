// "Has this been asked already?" on a real database with pgvector (spec §11.1).
import { beforeAll, describe, expect, it } from 'vitest';
import { embedMissing } from '../src/backfill.ts';
import { localEmbedder, type Embedder } from '../src/embeddings.ts';
import { speller, trainSpelling } from '../src/ml/spelling.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;
let searcher: string | undefined;
const embedder = localEmbedder();
let embedCalls = 0;
const observedEmbedder: Embedder = {
  model: embedder.model,
  dims: embedder.dims,
  embed: async texts => {
    embedCalls += texts.length;
    return embedder.embed(texts);
  },
};

beforeAll(async () => {
  h = await startApp(() => Date.now(), { embedder: observedEmbedder });
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `pre.${String(names)}`,
        country: 'IN',
        fields: ['imports-customs', 'travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ai_personalization', enabled: true }] }))
      .statusCode,
  ).toBe(200);
  searcher = p.token;
  return p;
}

async function ask(title: string, field = 'imports-customs') {
  const p = await member();
  const res = await h.call('POST', '/questions', p.token, { title, field });
  expect(res.statusCode).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id);
}

async function answer(q: string) {
  const p = await member();
  expect(
    (
      await h.call('POST', `/questions/${q}/answers`, p.token, {
        body: 'Paid ₹95,000 in duty at Chennai air cargo last month.',
      })
    ).statusCode,
  ).toBe(201);
}

interface Precheck {
  verdict: string;
  questions: Array<{ id: string; title: string; similarity: number | null }>;
}
const precheck = async (title: string, field?: string, token = searcher) =>
  (await h.call('POST', '/questions/precheck', token, { title, ...(field ? { field } : {}) })).json<Precheck>();

describe('has it been asked already?', () => {
  it('does not send question content to the embedding provider without AI consent', async () => {
    const person = await h.person();
    expect(
      (
        await h.call('POST', '/me/profile', person.token, {
          handle: 'pre.noai',
          country: 'IN',
          fields: ['imports-customs'],
          adult: true,
        })
      ).statusCode,
    ).toBe(201);
    const beforePrecheck = embedCalls;
    await h.call('POST', '/questions/precheck', person.token, {
      title: 'How do I clear a camera lens through customs at the airport?',
    });
    expect(embedCalls).toBe(beforePrecheck);
    const response = await h.call('POST', '/questions', person.token, {
      title: 'How do I clear a camera lens through customs at the airport?',
      field: 'imports-customs',
    });
    const id = response.json<{ question: { id: string } }>().question.id;
    expect((await h.t.owner.query('SELECT embedding FROM app.questions WHERE id = $1', [id])).rows).toEqual([
      { embedding: null },
    ]);
    expect(await embedMissing(h.t.database, embedder)).toBe(0);
  });

  it('records searches and question views only under their independent consents', async () => {
    const person = await member();
    const title = 'Which documents do customs ask for when importing a used camera from Japan?';
    await precheck(title, undefined, person.token);
    const empty = await h.call('GET', '/me/graph', person.token);
    expect(empty.json<{ graph: { signals: Array<{ signalType: string }> } }>().graph.signals).toEqual([]);

    expect(
      await h.call('PUT', '/me/consents', person.token, {
        choices: [
          { category: 'search_history', enabled: true },
          { category: 'reading_history', enabled: true },
        ],
      }),
    ).toMatchObject({ statusCode: 200 });
    const searchCheck = await h.call('POST', '/questions/precheck', person.token, { title });
    expect(searchCheck.statusCode, searchCheck.body).toBe(200);
    expect(
      (await h.call('GET', '/me/consents', person.token))
        .json<{ categories: Array<{ name: string; enabled: boolean }> }>()
        .categories.find(category => category.name === 'search_history')?.enabled,
    ).toBe(true);
    const questionId = await ask(title);
    await h.call('GET', `/questions/${questionId}`, person.token);
    const signals = (await h.call('GET', '/me/graph', person.token)).json<{
      graph: { signals: Array<{ category: string; signalType: string; value: Record<string, unknown> }> };
    }>().graph.signals;
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'search_history',
          signalType: 'question_precheck',
          value: { query: title, field: null },
        }),
        expect.objectContaining({ category: 'reading_history', signalType: 'question_viewed', subjectId: questionId }),
      ]),
    );

    await h.call('PUT', '/me/consents', person.token, {
      choices: [{ category: 'search_history', enabled: false }],
    });
    await precheck('How do I import a refurbished tablet through customs in Japan?', undefined, person.token);
    const afterRevocation = (await h.call('GET', '/me/graph', person.token)).json<{
      graph: { signals: Array<{ category: string }> };
    }>().graph.signals;
    expect(afterRevocation.filter(signal => signal.category === 'search_history')).toHaveLength(1);
  });

  it('stores each new question’s meaning, from the model that made it', async () => {
    const q = await ask('How much customs duty did you pay importing a watch through Chennai airport?');
    const { rows } = await h.t.owner.query<{ model: string; has: boolean }>(
      'SELECT embedding_model AS model, embedding IS NOT NULL AS has FROM app.questions WHERE id = $1',
      [q],
    );
    expect(rows).toEqual([{ model: embedder.model, has: true }]);
  });

  it('clears stored question vectors as soon as AI consent is revoked', async () => {
    const q = await ask('How do I declare a camera lens at customs in Mumbai?');
    const ownerToken = must(searcher, 'signed-in asker token');
    expect(
      (
        await h.t.owner.query<{ has: boolean }>(
          'SELECT embedding IS NOT NULL AS has FROM app.questions WHERE id = $1',
          [q],
        )
      ).rows,
    ).toEqual([{ has: true }]);
    expect(
      (
        await h.call('PUT', '/me/consents', ownerToken, {
          choices: [{ category: 'ai_personalization', enabled: false }],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.t.owner.query<{ embedding: unknown; model: string | null }>(
          'SELECT embedding, embedding_model AS model FROM app.questions WHERE id = $1',
          [q],
        )
      ).rows,
    ).toEqual([{ embedding: null, model: null }]);
    searcher = (await member()).token;
  });

  it('offers an answered question asked the same way as the one to read first', async () => {
    const q = await ask('Which documents did customs ask for when importing a used car from Japan?');
    await answer(q);
    const res = await precheck('Which documents did customs ask for when importing a used car from Japan?');
    expect(res.verdict).toBe('duplicate');
    expect(res.questions[0]).toMatchObject({ id: q });
    expect(res.questions[0]?.similarity).toBeGreaterThanOrEqual(0.88);
  });

  it('finds a question written in Telugu by its words, and not by fragments of them', async () => {
    const q = await ask('దుబాయ్ నుండి వాచ్ తెస్తే కస్టమ్స్ డ్యూటీ ఎంత కట్టాలి?');
    await answer(q);
    expect((await precheck('కస్టమ్స్ డ్యూటీ ఎంత కట్టాలి')).questions.map(x => x.id)).toContain(q);
    // Shares only single letters with it: split at vowel signs, this used to match.
    expect((await precheck('తెలంగాణలో వర్షాలు ఎప్పుడు')).questions.map(x => x.id)).not.toContain(q);
  });

  it('finds a question from half-typed words that mean little by themselves', async () => {
    const q = await ask('Is the BOE-II form needed for a courier parcel valued under 5000?');
    await answer(q);
    const res = await precheck('courier parcel BOE-I');
    expect(res.verdict).toBe('related');
    expect(res.questions.map(x => x.id)).toContain(q);
    // Sharing one common word isn't enough to be shown.
    expect((await precheck('courier pigeons in medieval castles')).questions.map(x => x.id)).not.toContain(q);
  });

  it('keeps the question being typed in view among many close in meaning', async () => {
    // Twelve phrased almost as typed; the one meant is worded quite differently.
    for (let i = 0; i < 12; i++) await ask(`Vintage camera case qq${String(i)}0912 at customs?`);
    const q = await ask(
      'Customs held my Leica under case zz4471 at Dubai airport: was the duty on a vintage camera fair?',
    );
    const res = await precheck('vintage camera case zz44');
    expect(res.verdict).toBe('related');
    expect(res.questions[0]?.id).toBe(q);
  });

  it('only shows it alongside when it has no answer yet', async () => {
    const q = await ask('Do you need an appointment to renew a residence card in Osaka?');
    const res = await precheck('Do you need an appointment to renew a residence card in Osaka?');
    expect(res.verdict).toBe('related');
    expect(res.questions.map(x => x.id)).toContain(q);
  });

  it('stays out of the way for a new question, and for short drafts', async () => {
    expect(await precheck('Where can I service a vintage Omega Seamaster in Pune?')).toEqual({
      verdict: 'clear',
      questions: [],
    });
    // "Osaka?" would match the Osaka question by words; a draft that short isn't searched.
    expect(await precheck('Osaka?')).toEqual({ verdict: 'clear', questions: [] });
  });

  it('answers text with no words in it, without an error', async () => {
    // Search operators and punctuation only: nothing to match by words, and no meaning to compare.
    for (const title of ["& | ! :* <-> ( ) '", '!!!!!!!!!!!!', '?? ... ?? ... ??']) {
      const res = await h.call('POST', '/questions/precheck', undefined, { title });
      expect(res.statusCode, title).toBe(200);
      expect(res.json<{ verdict: string }>().verdict, title).toMatch(/^(clear|related)$/);
    }
  });

  it('looks within the field it’s asked about', async () => {
    const q = await ask('What is the best month to see the northern lights in Tromso?', 'travel');
    await answer(q);
    expect((await precheck('What is the best month to see the northern lights in Tromso?', 'travel')).verdict).toBe(
      'duplicate',
    );
    expect(
      (await precheck('What is the best month to see the northern lights in Tromso?', 'imports-customs')).verdict,
    ).toBe('clear');
  });

  it('never compares meanings made by different models', async () => {
    const q = await ask('How long does a FedEx customs hold take for a laptop in Bangalore?');
    await answer(q);
    await h.t.owner.query("UPDATE app.questions SET embedding_model = 'an-older-model' WHERE id = $1", [q]);
    const res = await precheck('How long does a FedEx customs hold take for a laptop in Bangalore?');
    // Found by words at most, never judged by meaning.
    expect(res.verdict).not.toBe('duplicate');
    for (const x of res.questions.filter(x => x.id === q)) expect(x.similarity).toBeNull();
  });

  it('never shows a hidden question', async () => {
    const q = await ask('Can I bring two bottles of whisky through Mumbai airport duty free?');
    await answer(q);
    await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [q]);
    const res = await precheck('Can I bring two bottles of whisky through Mumbai airport duty free?');
    expect(res.questions.map(x => x.id)).not.toContain(q);
  });

  it('refuses unknown fields and anything extra', async () => {
    expect(
      (await h.call('POST', '/questions/precheck', undefined, { title: 'A long enough draft question here', extra: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await h.call('POST', '/questions/precheck', undefined, {
          title: 'A long enough draft question here',
          field: 'Nope!',
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('the background job', () => {
  it('does nothing when every question has its meaning, and waits when Cloudflare can’t answer', async () => {
    while ((await embedMissing(h.t.database, embedder)) > 0) {
      /* catch up on this file's questions */
    }
    expect(await embedMissing(h.t.database, embedder)).toBe(0);
    const qid = await ask('What does the courier charge to clear a parcel of books in Delhi?');
    expect(
      (
        await h.t.owner.query(
          `SELECT s.enabled FROM app.user_consent_settings s
           JOIN app.questions q ON q.asker_id = s.user_id
           WHERE q.id = $1 AND s.category = 'ai_personalization'`,
          [qid],
        )
      ).rows,
    ).toEqual([{ enabled: true }]);
    await h.t.owner.query(
      'UPDATE app.questions SET embedding = NULL, embedding_model = NULL WHERE embedding_model IS NOT NULL AND id = (SELECT max(id) FROM app.questions)',
    );
    const down: Embedder = {
      model: embedder.model,
      dims: embedder.dims,
      embed: () => Promise.reject(new Error('limit')),
    };
    expect(await embedMissing(h.t.database, down)).toBe(0);
    expect(await embedMissing(h.t.database, embedder)).toBe(1);
  });
});

describe('without meaning (out of the free allowance, or offline)', () => {
  it('still asks, still finds by words, and never stops anyone on words alone', async () => {
    const failing: Embedder = {
      model: embedder.model,
      dims: embedder.dims,
      embed: () => Promise.reject(new Error('limit')),
    };
    const off = await startApp(() => Date.now(), { embedder: failing });
    try {
      const p = await off.person();
      expect(
        (
          await off.call('POST', '/me/profile', p.token, {
            handle: 'offline.one',
            country: 'IN',
            fields: ['imports-customs'],
            adult: true,
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await off.call('PUT', '/me/consents', p.token, {
            choices: [{ category: 'ai_personalization', enabled: true }],
          })
        ).statusCode,
      ).toBe(200);
      const res = await off.call('POST', '/questions', p.token, {
        title: 'Which customs form do I need for a camera lens import?',
        field: 'imports-customs',
      });
      expect(res.statusCode).toBe(201);
      const check = (
        await off.call('POST', '/questions/precheck', undefined, {
          title: 'Which customs form do I need for a camera lens import?',
        })
      ).json<Precheck>();
      expect(check.verdict).toBe('related');
      expect(check.questions[0]?.similarity).toBeNull();
      // A draft too short to mean anything isn't searched, even where words alone would match.
      expect((await off.call('POST', '/questions/precheck', undefined, { title: 'Camera?' })).json<Precheck>()).toEqual(
        { verdict: 'clear', questions: [] },
      );
      // The background job fills in the missing meaning once it's back.
      const q = must(res.json<{ question: { id: string } }>().question.id);
      expect(await embedMissing(off.t.database, embedder)).toBeGreaterThanOrEqual(1);
      const { rows } = await off.t.owner.query<{ has: boolean }>(
        'SELECT embedding IS NOT NULL AS has FROM app.questions WHERE id = $1',
        [q],
      );
      expect(rows).toEqual([{ has: true }]);
    } finally {
      await off.close();
    }
  });
});

describe('with Graphinity’s own spelling model', () => {
  it('finds a question through typos, while searching what was typed as typed', async () => {
    const learned = speller(
      trainSpelling(
        Array.from({ length: 5 }, () => 'customs duty on a camera lens at the airport'),
        { lambda: 4, mu: 5, minCount: 2, keep: -1000 },
      ),
    );
    const app = await startApp(() => Date.now(), { embedder, speller: learned });
    try {
      const p = await app.person();
      expect(
        (
          await app.call('POST', '/me/profile', p.token, {
            handle: 'spell.one',
            country: 'IN',
            fields: ['imports-customs'],
            adult: true,
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.call('PUT', '/me/consents', p.token, {
            choices: [{ category: 'ai_personalization', enabled: true }],
          })
        ).statusCode,
      ).toBe(200);
      const asked = await app.call('POST', '/questions', p.token, {
        title: 'Customs duty on a camera lens',
        field: 'imports-customs',
      });
      expect(asked.statusCode).toBe(201);
      const id = must(asked.json<{ question: { id: string } }>().question.id);
      const check = async (title: string, token?: string) =>
        (await app.call('POST', '/questions/precheck', token, { title })).json<Precheck>();

      // Words only (a visitor: no meaning without consent): no typed word is in the question.
      expect(await check('Cusotms for my camrea please')).toMatchObject({ verdict: 'related', questions: [{ id }] });
      // With meaning: every word, once corrected, is in it, so it's shown even if meanings differ.
      expect(await check('Cusotms duty camrea lens', p.token)).toMatchObject({
        verdict: 'related',
        questions: [{ id }],
      });
      // A word it doesn't know is searched as typed, never swapped for a guess.
      expect(await check('Zxqvbn for my wjkdhf please')).toEqual({ verdict: 'clear', questions: [] });
    } finally {
      await app.close();
    }
  });
});
