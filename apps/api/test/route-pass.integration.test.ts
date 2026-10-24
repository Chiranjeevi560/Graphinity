import { beforeAll, describe, expect, it } from 'vitest';
import { routeWave } from '../src/routing.ts';
import { startApp, type TestApp } from './helpers/app.ts';

let h: TestApp;
let sequence = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(field = 'imports-customs') {
  const person = await h.person();
  sequence += 1;
  const response = await h.call('POST', '/me/profile', person.token, {
    handle: `routepass.${String(sequence)}`,
    country: 'IN',
    fields: [field],
    adult: true,
  });
  expect(response.statusCode).toBe(201);
  return person;
}

describe('passing a routed question', () => {
  it('hides a passed route and lets only its recipient undo within seven seconds', async () => {
    const asker = await member();
    const recipient = await member();
    const question = await h.call('POST', '/questions', asker.token, {
      title: 'How do I clear imported goods at the airport?',
      field: 'imports-customs',
      country: 'IN',
    });
    const id = question.json<{ question: { id: string } }>().question.id;
    expect(await h.t.database.asSystem(q => routeWave(q, id, 1, 1))).toEqual([recipient.id]);
    const exportResponse = await h.call('GET', '/me/data-export', recipient.token);
    const exportedRoutes = exportResponse.json<{
      interactions: {
        routedQuestions: Array<{
          questionId: string;
          rankingVersion: number | null;
          rankingScore: number | null;
          expertiseWeight: number | null;
          circadianFit: number | null;
          diversityFit: number | null;
        }>;
      };
    }>().interactions.routedQuestions;
    expect(exportedRoutes).toHaveLength(1);
    expect(exportedRoutes[0]).toMatchObject({ questionId: id, rankingVersion: 1 });
    expect(exportedRoutes[0]?.rankingScore).toEqual(expect.any(Number));
    expect(exportedRoutes[0]?.expertiseWeight).toEqual(expect.any(Number));
    expect(exportedRoutes[0]?.circadianFit).toEqual(expect.any(Number));
    expect(exportedRoutes[0]?.diversityFit).toEqual(expect.any(Number));

    const pass = await h.call('POST', `/me/inbox/${id}/pass`, recipient.token);
    expect(pass.statusCode).toBe(201);
    const { undoUntil } = pass.json<{ undoUntil: string }>();
    expect(Date.parse(undoUntil)).toBeGreaterThan(Date.now());
    expect((await h.call('POST', `/me/inbox/${id}/pass`, recipient.token)).statusCode).toBe(409);
    expect(
      (await h.call('GET', '/me/inbox', recipient.token)).json<{
        questions: Array<{ id: string; passUndoUntil: string }>;
      }>().questions,
    ).toEqual([expect.objectContaining({ id, passUndoUntil: undoUntil })]);

    expect((await h.call('POST', `/me/inbox/${id}/undo-pass`, asker.token)).statusCode).toBe(409);
    expect((await h.call('POST', `/me/inbox/${id}/undo-pass`, recipient.token)).statusCode).toBe(204);
    expect(
      (await h.call('GET', '/me/inbox', recipient.token)).json<{
        questions: Array<{ id: string; passUndoUntil: null }>;
      }>().questions,
    ).toEqual([expect.objectContaining({ id, passUndoUntil: null })]);
  });

  it('rejects undo after the database-clock deadline and removes expired passes from the inbox', async () => {
    const asker = await member('food-cooking');
    const recipient = await member('food-cooking');
    const question = await h.call('POST', '/questions', asker.token, {
      title: 'What is the import duty for a small parcel?',
      field: 'food-cooking',
      country: 'IN',
    });
    const id = question.json<{ question: { id: string } }>().question.id;
    expect(await h.t.database.asSystem(q => routeWave(q, id, 1, 1))).toEqual([recipient.id]);
    expect((await h.call('POST', `/me/inbox/${id}/pass`, recipient.token)).statusCode).toBe(201);
    await new Promise(resolve => setTimeout(resolve, 7_100));
    expect((await h.call('POST', `/me/inbox/${id}/undo-pass`, recipient.token)).statusCode).toBe(409);
    expect(
      (await h.call('GET', '/me/inbox', recipient.token)).json<{ questions: Array<{ id: string }> }>().questions,
    ).toEqual([]);
  }, 10_000);
});
