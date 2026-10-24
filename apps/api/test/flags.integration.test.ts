// Feature flags against a real database: the owner flips them, the API only reads.
import { beforeAll, describe, expect, it } from 'vitest';
import { createFlags, switchedEmbedder } from '../src/flags.ts';
import { localEmbedder } from '../src/embeddings.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  return () => t.close();
});

describe('feature flags', () => {
  it('start with the switches the code knows, all on', async () => {
    const { rows } = await t.api.query('SELECT name, enabled FROM app.feature_flags ORDER BY name');
    expect(rows).toEqual([
      { name: 'embeddings', enabled: true },
      { name: 'model_training', enabled: true },
      { name: 'push', enabled: true },
      { name: 'recommendations', enabled: true },
    ]);
  });

  it('can be read by the API but never changed by it', async () => {
    for (const sql of [
      "UPDATE app.feature_flags SET enabled = false WHERE name = 'push'",
      "INSERT INTO app.feature_flags (name, enabled) VALUES ('new_thing', true)",
      "DELETE FROM app.feature_flags WHERE name = 'push'",
    ])
      await expect(t.api.query(sql), sql).rejects.toMatchObject({ code: '42501' });
  });

  it('reach the server on its next refresh, and say what changed', async () => {
    const changes: Array<[string, boolean]> = [];
    const flags = createFlags(t.database, { refreshMs: 60_000, onChange: (n, e) => changes.push([n, e]) });
    try {
      await flags.refresh();
      expect(flags.enabled('embeddings')).toBe(true);
      await t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'embeddings'");
      expect(flags.enabled('embeddings')).toBe(true); // not until the refresh
      await flags.refresh();
      expect(flags.enabled('embeddings')).toBe(false);
      expect(flags.enabled('push')).toBe(true);
      expect(flags.enabled('recommendations')).toBe(true);
      expect(changes).toEqual([['embeddings', false]]);
    } finally {
      flags.stop();
      await t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'embeddings'");
    }
  });
});

describe('the embeddings switch, off', () => {
  let h: TestApp;
  beforeAll(async () => {
    const off = { enabled: () => false };
    h = await startApp(() => Date.now(), { embedder: switchedEmbedder(localEmbedder(), off) });
    return h.close;
  });

  it('leaves asking and finding working, by words, and never stops anyone', async () => {
    const p = await h.person();
    expect(
      (
        await h.call('POST', '/me/profile', p.token, {
          handle: 'switch.off',
          country: 'IN',
          fields: ['imports-customs'],
          adult: true,
        })
      ).statusCode,
    ).toBe(201);
    const title = 'Which customs form do I need to import a used espresso machine?';
    const asked = await h.call('POST', '/questions', p.token, { title, field: 'imports-customs' });
    expect(asked.statusCode).toBe(201);
    const id = asked.json<{ question: { id: string } }>().question.id;
    // Stored without a meaning: nothing was sent to the embedder.
    expect((await h.t.owner.query('SELECT embedding FROM app.questions WHERE id = $1', [id])).rows).toEqual([
      { embedding: null },
    ]);
    const res = await h.call('POST', '/questions/precheck', undefined, { title });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ verdict: string; questions: Array<{ id: string; similarity: number | null }> }>();
    // Words alone are only ever "related" (precheck.ts).
    expect(body.verdict).toBe('related');
    expect(body.questions).toContainEqual(expect.objectContaining({ id, similarity: null }));
  });
});
