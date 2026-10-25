import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';

let h: TestApp;
beforeAll(async () => {
  h = await startApp(() => Date.parse('2026-10-22T10:00:00Z'));
  return h.close;
});

async function createPerson(handle: string) {
  const person = await h.person();
  const profile = await h.call('POST', '/me/profile', person.token, {
    handle,
    country: 'IN',
    fields: ['imports-customs'],
    adult: true,
  });
  expect(profile.statusCode).toBe(201);
  return person;
}

describe('consent controls', () => {
  it('asks once about improving search for everyone: any answer ends the asking, for good', async () => {
    const person = await createPerson('consent.once');
    const read = async () =>
      (await h.call('GET', '/me/consents', person.token)).json<{
        awaitingAnswer: string[];
        categories: Array<{ name: string; enabled: boolean }>;
      }>();
    const first = await read();
    expect(first.awaitingAnswer).toEqual(['search_improvement']);
    expect(first.categories.find(c => c.name === 'search_improvement')?.enabled).toBe(false);
    // "Not now" is an answer too.
    expect(
      (
        await h.call('PUT', '/me/consents', person.token, {
          choices: [{ category: 'search_improvement', enabled: false }],
        })
      ).statusCode,
    ).toBe(200);
    expect((await read()).awaitingAnswer).toEqual([]);
    // Changing their mind later, either way, never brings the question back.
    for (const enabled of [true, false])
      await h.call('PUT', '/me/consents', person.token, { choices: [{ category: 'search_improvement', enabled }] });
    expect((await read()).awaitingAnswer).toEqual([]);
  });

  it('describes what really happens: nothing goes to an outside AI, and when reading time is measured', async () => {
    const person = await createPerson('consent.text');
    const categories = (await h.call('GET', '/me/consents', person.token)).json<{
      categories: Array<{ name: string; dataDescription: string; recipients: string; policyVersion: number }>;
    }>().categories;
    const ai = categories.find(c => c.name === 'ai_personalization');
    expect(ai?.recipients).toBe('Graphinity only. No outside AI service is used.');
    expect(ai?.policyVersion).toBe(3);
    expect(JSON.stringify(categories)).not.toMatch(/Cloudflare/);
    expect(categories.find(c => c.name === 'reading_history')?.dataDescription).toMatch(/only if "improve search/);
    expect(categories.find(c => c.name === 'search_improvement')?.dataDescription).toMatch(/nothing from before/);
  });

  it('shows every purpose and defaults optional collection off', async () => {
    const person = await createPerson('consent.read');
    const response = await h.call('GET', '/me/consents', person.token);
    expect(response.statusCode).toBe(200);
    const categories = response.json<{
      categories: Array<{ name: string; enabled: boolean; requiredForService: boolean }>;
    }>().categories;
    expect(categories.length).toBeGreaterThanOrEqual(15);
    expect(categories.find(category => category.name === 'identity')).toMatchObject({
      enabled: true,
      requiredForService: true,
    });
    expect(categories.find(category => category.name === 'commercial_personalization')).toMatchObject({
      enabled: false,
      requiredForService: false,
    });
  });

  it('records choices and changes in an account-private audit history', async () => {
    const person = await createPerson('consent.change');
    expect(
      (
        await h.call('PUT', '/me/consents', person.token, {
          choices: [
            { category: 'commercial_personalization', enabled: true },
            { category: 'purchase_history', enabled: true },
          ],
        })
      ).json(),
    ).toEqual({ changed: 2 });
    expect(
      (
        await h.call('PUT', '/me/consents', person.token, {
          choices: [{ category: 'commercial_personalization', enabled: false }],
        })
      ).json(),
    ).toEqual({ changed: 1 });
    const settings = await h.call('GET', '/me/consents', person.token);
    expect(
      settings
        .json<{ categories: Array<{ name: string; enabled: boolean }> }>()
        .categories.find(category => category.name === 'commercial_personalization')?.enabled,
    ).toBe(false);
    const history = await h.call('GET', '/me/consents/audit', person.token);
    expect(history.json<{ history: Array<{ category: string; enabled: boolean }> }>().history).toEqual([
      expect.objectContaining({ category: 'commercial_personalization', enabled: false }),
      expect.objectContaining({ category: 'purchase_history', enabled: true }),
      expect.objectContaining({ category: 'commercial_personalization', enabled: true }),
    ]);
    const other = await createPerson('consent.other');
    expect((await h.call('GET', '/me/consents/audit', other.token)).json()).toEqual({ history: [] });
  });

  it('refuses unknown, duplicate, and required-purpose revocations', async () => {
    const person = await createPerson('consent.refuse');
    for (const choices of [
      [{ category: 'not_a_category', enabled: true }],
      [
        { category: 'search_history', enabled: true },
        { category: 'search_history', enabled: false },
      ],
      [{ category: 'identity', enabled: false }],
    ]) {
      const response = await h.call('PUT', '/me/consents', person.token, { choices });
      expect(response.statusCode).toBe(400);
    }
  });

  it('does not add duplicate history when a choice is saved without changing it', async () => {
    const person = await createPerson('consent.noop');
    const choice = { choices: [{ category: 'search_history', enabled: true }] };
    expect((await h.call('PUT', '/me/consents', person.token, choice)).json()).toEqual({ changed: 1 });
    expect((await h.call('PUT', '/me/consents', person.token, choice)).json()).toEqual({ changed: 0 });
    const history = await h.call('GET', '/me/consents/audit', person.token);
    expect(history.json<{ history: unknown[] }>().history).toHaveLength(1);
  });

  it('does not allow the API role to rewrite or erase consent audit history', async () => {
    const person = await createPerson('consent.append');
    await h.call('PUT', '/me/consents', person.token, {
      choices: [{ category: 'search_history', enabled: true }],
    });
    for (const sql of [
      'UPDATE app.user_consent_audit_log SET enabled = false WHERE user_id = $1',
      'DELETE FROM app.user_consent_audit_log WHERE user_id = $1',
    ]) {
      await expect(h.t.api.query(sql, [person.id])).rejects.toMatchObject({ code: '42501' });
    }
  });
});
