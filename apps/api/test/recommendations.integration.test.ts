import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';

let h: TestApp;
let serial = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(fields: string[]) {
  const person = await h.person();
  serial += 1;
  const profile = await h.call('POST', '/me/profile', person.token, {
    handle: `recs.${String(serial)}`,
    country: 'IN',
    fields,
    adult: true,
  });
  expect(profile.statusCode).toBe(201);
  return person;
}

async function question(token: string, title: string, field: string) {
  const response = await h.call('POST', '/questions', token, { title, field });
  expect(response.statusCode).toBe(201);
  return response.json<{ question: { id: string } }>().question.id;
}

async function allow(token: string, ...categories: string[]) {
  const response = await h.call('PUT', '/me/consents', token, {
    choices: categories.map(category => ({ category, enabled: true })),
  });
  expect(response.statusCode).toBe(200);
}

describe('consent-aware knowledge recommendations', () => {
  it('defaults off and uses search history only while its separate consent is active', async () => {
    const reader = await member(['imports-customs']);
    const author = await member(['travel']);
    const title = 'Which documents are needed to import a used camera through Japan customs?';
    const candidateId = await question(author.token, title, 'travel');

    const disabled = await h.call('GET', '/me/recommendations', reader.token);
    expect(disabled.json()).toMatchObject({ enabled: false, recommendations: [] });

    await allow(reader.token, 'feed_personalization', 'search_history');
    await h.call('POST', '/questions/precheck', reader.token, {
      title: 'Which documents are needed to import a used camera through Japan customs?',
      field: 'travel',
    });
    const enabled = await h.call('GET', '/me/recommendations', reader.token);
    const result = enabled.json<{
      enabled: boolean;
      algorithmVersion: string;
      recommendations: Array<{ id: string; reason: string; score: number }>;
    }>();
    expect(result.enabled).toBe(true);
    expect(result.algorithmVersion).toBe('feed-rrf-v3');
    expect(result.recommendations.find(item => item.id === candidateId)).toMatchObject({
      reason: 'Related to your recent Graphinity searches',
    });

    await h.call('PUT', '/me/consents', reader.token, {
      choices: [{ category: 'search_history', enabled: false }],
    });
    const afterRevocation = await h.call('GET', '/me/recommendations', reader.token);
    expect(
      afterRevocation
        .json<{ recommendations: Array<{ id: string; reason: string }> }>()
        .recommendations.find(item => item.id === candidateId)?.reason,
    ).not.toBe('Related to your recent Graphinity searches');
  });

  it('uses viewed topics only when reading-history consent remains enabled', async () => {
    const reader = await member(['imports-customs']);
    const author = await member(['travel']);
    const viewedId = await question(
      author.token,
      'Which forms does customs require for an imported used camera?',
      'travel',
    );
    const candidateId = await question(
      author.token,
      'Which documents are needed to import a used camera through Japan customs?',
      'travel',
    );
    await allow(reader.token, 'feed_personalization', 'reading_history');
    expect((await h.call('GET', `/questions/${viewedId}`, reader.token)).statusCode).toBe(200);
    expect(
      (await h.call('GET', '/me/graph', reader.token)).json<{
        graph: { signals: Array<{ category: string; subjectId: string | null }> };
      }>().graph.signals,
    ).toContainEqual(expect.objectContaining({ category: 'reading_history', subjectId: viewedId }));
    const match = await h.t.owner.query<{ rank: number; viewed: string; candidate: string }>(
      `SELECT ts_rank_cd(candidate.search, replace(plainto_tsquery('english', viewed.title)::text, ' & ', ' | ')::tsquery)::float8 AS rank,
              viewed.title AS viewed, candidate.title AS candidate
       FROM app.questions viewed CROSS JOIN app.questions candidate
       WHERE viewed.id = $1 AND candidate.id = $2`,
      [viewedId, candidateId],
    );
    expect(match.rows[0]?.rank).toBeGreaterThan(0);

    const response = await h.call('GET', '/me/recommendations', reader.token);
    const result = response.json<{ recommendations: Array<{ id: string; reason: string }> }>();
    expect(result.recommendations.some(item => item.id === viewedId)).toBe(false);
    expect(result.recommendations.find(item => item.id === candidateId)?.reason).toBe(
      'Similar to a question you opened',
    );

    await h.call('PUT', '/me/consents', reader.token, {
      choices: [{ category: 'reading_history', enabled: false }],
    });
    const afterRevocation = await h.call('GET', '/me/recommendations', reader.token);
    expect(
      afterRevocation
        .json<{ recommendations: Array<{ id: string; reason: string }> }>()
        .recommendations.find(item => item.id === candidateId)?.reason,
    ).not.toBe('Similar to a question you opened');
  });

  it('does not run the ranking query when the global kill switch is off', async () => {
    const disabledApp = await startApp(() => Date.now(), { recommendationsEnabled: () => false });
    try {
      const reader = await disabledApp.person();
      expect(
        (
          await disabledApp.call('POST', '/me/profile', reader.token, {
            handle: `recs.${String(++serial)}`,
            country: 'IN',
            fields: ['imports-customs'],
            adult: true,
          })
        ).statusCode,
      ).toBe(201);
      await disabledApp.call('PUT', '/me/consents', reader.token, {
        choices: [{ category: 'feed_personalization', enabled: true }],
      });
      const response = await disabledApp.call('GET', '/me/recommendations', reader.token);
      expect(response.json()).toMatchObject({ enabled: false, availability: 'unavailable', recommendations: [] });
    } finally {
      await disabledApp.close();
    }
  });

  it('uses searches from the Search screen too, through the search engine', async () => {
    const reader = await member(['imports-customs']);
    const author = await member(['travel']);
    const candidateId = await question(
      author.token,
      'How long is the Schengen visa wait at Kochi in winter?',
      'travel',
    );
    await allow(reader.token, 'feed_personalization', 'search_history');
    expect((await h.call('POST', '/search', reader.token, { query: 'schengen kochi' })).statusCode).toBe(200);
    const result = (await h.call('GET', '/me/recommendations', reader.token)).json<{
      recommendations: Array<{ id: string; reason: string }>;
    }>();
    expect(result.recommendations.find(item => item.id === candidateId)).toMatchObject({
      reason: 'Related to your recent Graphinity searches',
    });
  });

  it('recommends what the same people answered as a question you opened, from public answers', async () => {
    const reader = await member(['imports-customs']);
    const author = await member(['travel']);
    const expert = await member(['travel']);
    const opened = await question(author.token, 'What does a courier charge to clear a sitar at Kolkata?', 'travel');
    // Shares no words with the opened one: only the shared answerer connects them.
    const related = await question(author.token, 'Is there a waiting list for tabla repair in Varanasi?', 'travel');
    for (const id of [opened, related])
      expect(
        (
          await h.call('POST', `/questions/${id}/answers`, expert.token, {
            body: 'I did this myself last spring; it took about a week and the fee was fair.',
          })
        ).statusCode,
      ).toBe(201);
    await allow(reader.token, 'feed_personalization', 'reading_history');
    await h.call('GET', `/questions/${opened}`, reader.token);
    const result = (await h.call('GET', '/me/recommendations', reader.token)).json<{
      recommendations: Array<{ id: string; reason: string }>;
    }>();
    expect(result.recommendations.find(item => item.id === related)).toMatchObject({
      reason: 'Answered by people who answered one you opened',
    });
    expect(result.recommendations.map(item => item.id)).not.toContain(opened);
  });

  it('fills with topics and recent questions only after the personal sources, and never shows your own', async () => {
    const reader = await member(['travel']);
    const author = await member(['travel']);
    const expert = await member(['travel']);
    const opened = await question(author.token, 'What does a courier charge to clear a veena at Chennai?', 'travel');
    // In another topic and older than the recent window: only the shared answerer connects it.
    const related = await question(
      author.token,
      'Is there a waiting list for mridangam repair in Madurai?',
      'imports-customs',
    );
    for (const id of [opened, related])
      await h.call('POST', `/questions/${id}/answers`, expert.token, {
        body: 'I did this myself last spring; it took about a week and the fee was fair.',
      });
    await h.t.owner.query("UPDATE app.questions SET created_at = now() - interval '40 days' WHERE id = $1", [related]);
    // Answered by the reader already, and hidden: never recommended, whichever source finds them.
    // A second author: a new account asks at most 3 questions a day.
    const another = await member(['travel']);
    const answeredByReader = await question(
      another.token,
      'Can a nadaswaram go as cabin baggage to Chennai?',
      'travel',
    );
    const hidden = await question(another.token, 'Which courier clears a thavil fastest at Chennai?', 'travel');
    await h.call('POST', `/questions/${answeredByReader}/answers`, reader.token, {
      body: 'I carried mine last year in the cabin; they let it through after a short look.',
    });
    await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [hidden]);
    // Newest, and in the reader's own topic: first by fields and by recency, both.
    const topical = await question(
      author.token,
      'Which travel card works best for Schengen trips from Pune?',
      'travel',
    );
    const mine = await question(reader.token, 'Has anyone shipped a ghatam to Mumbai by courier?', 'travel');
    await h.call('POST', `/questions/${mine}/answers`, expert.token, {
      body: 'I did this myself last spring; it took about a week and the fee was fair.',
    });
    await allow(reader.token, 'feed_personalization', 'reading_history');
    await h.call('GET', `/questions/${opened}`, reader.token);
    const ids = (await h.call('GET', '/me/recommendations', reader.token))
      .json<{ recommendations: Array<{ id: string }> }>()
      .recommendations.map(item => item.id);
    // Fused all together, the topic question (first in two sources) would come first.
    expect(ids.indexOf(related)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(related)).toBeLessThan(ids.indexOf(topical));
    expect(ids).not.toContain(mine);
    expect(ids).not.toContain(answeredByReader);
    expect(ids).not.toContain(hidden);
    // Without reading history, what someone opened shapes nothing.
    await h.call('PUT', '/me/consents', reader.token, { choices: [{ category: 'reading_history', enabled: false }] });
    const after = (await h.call('GET', '/me/recommendations', reader.token)).json<{
      recommendations: Array<{ id: string; reason: string }>;
    }>();
    expect(after.recommendations.find(item => item.id === related)?.reason).not.toBe(
      'Answered by people who answered one you opened',
    );
  });

  it('leaves out questions older than six months', async () => {
    const reader = await member(['travel']);
    const author = await member(['travel']);
    const old = await question(author.token, 'Which bus pass covers both Mysuru and Ooty in one trip?', 'travel');
    await h.t.owner.query("UPDATE app.questions SET created_at = now() - interval '200 days' WHERE id = $1", [old]);
    await allow(reader.token, 'feed_personalization', 'search_history');
    await h.call('POST', '/search', reader.token, { query: 'bus pass mysuru ooty' });
    const ids = (await h.call('GET', '/me/recommendations', reader.token))
      .json<{ recommendations: Array<{ id: string }> }>()
      .recommendations.map(item => item.id);
    expect(ids).not.toContain(old);
  });
});
