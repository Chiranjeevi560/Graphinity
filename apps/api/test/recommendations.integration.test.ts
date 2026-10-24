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
    expect(result.algorithmVersion).toBe('feed-rrf-v2');
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
});
