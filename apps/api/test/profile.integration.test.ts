// The sign-in and profile flow end to end: the real server, the real token
// verifier (trusting a test key), and a real Postgres as the restricted role.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subjectHash } from '../src/auth.ts';
import { completePendingDeletions } from '../src/deletions.ts';
import { IP_HASH_KEY, startApp, type TestApp } from './helpers/app.ts';
import { handleExamples } from './handles.test.ts';
import { must, type Body } from './helpers/must.ts';

const KEY = IP_HASH_KEY;
let now = Date.parse('2026-10-17T10:00:00Z');
let h: TestApp;
let t: TestApp['t'];
let issuer: TestApp['issuer'];
let admin: TestApp['admin'];

beforeAll(async () => {
  h = await startApp(() => now);
  ({ t, issuer, admin } = h);
  return h.close;
});

beforeEach(() => {
  now = Date.parse('2026-10-17T10:00:00Z');
});

const person = () => h.person();
const call: TestApp['call'] = (...args) => h.call(...args);

const valid = { handle: 'chiru', country: 'IN', fields: ['imports-customs', 'watches-luxury'], adult: true };

describe('signing in', () => {
  it('refuses /me without a token, with a forged one, and says what to do', async () => {
    for (const res of [await call('GET', '/me'), await call('GET', '/me', 'not-a-token')]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'signed_out', message: 'You’re signed out. Sign in again to continue.' });
    }
  });

  it('a newly signed-in person has no profile until they set one up', async () => {
    const p = await person();
    const res = await call('GET', '/me', p.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: null });
  });
});

describe('creating a profile', () => {
  it('stores what the person chose and nothing from their sign-in provider', async () => {
    const p = await person();
    const res = await call('POST', '/me/profile', p.token, { ...valid, handle: '  Chiru.Create ' });
    expect(res.statusCode).toBe(201);
    expect(res.json<Body>().profile).toEqual({
      handle: 'chiru.create',
      country: { code: 'IN', name: 'India' },
      fields: [
        { slug: 'imports-customs', name: 'Imports & Customs' },
        { slug: 'watches-luxury', name: 'Watches & Luxury' },
      ],
      joined: '2026-10',
      handleChangeAvailableAt: null,
    });
    expect((await call('GET', '/me', p.token)).json<Body>().profile?.handle).toBe('chiru.create');
    const { rows } = await t.owner.query<{ adult_confirmed_at: Date }>(
      'SELECT adult_confirmed_at FROM app.profiles WHERE id = $1',
      [p.id],
    );
    expect(must(rows[0], 'the profile row').adult_confirmed_at.toISOString()).toBe('2026-10-17T10:00:00.000Z');
  });

  it('requires the 18+ confirmation to be exactly true', async () => {
    const p = await person();
    for (const adult of [false, 'true', 1, undefined]) {
      const res = await call('POST', '/me/profile', p.token, { ...valid, handle: 'adultcheck', adult });
      expect(res.statusCode, String(adult)).toBe(400);
    }
  });

  it('refuses unknown fields in the request instead of silently dropping them', async () => {
    const p = await person();
    const res = await call('POST', '/me/profile', p.token, { ...valid, handle: 'extra.field', isAdmin: true });
    expect(res.statusCode).toBe(400);
  });

  it('explains why a name is not allowed', async () => {
    const p = await person();
    const res = await call('POST', '/me/profile', p.token, { ...valid, handle: 'admin' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'invalid_handle',
      reason: 'reserved',
      message: 'That name is reserved. Try another.',
    });
  });

  it('keeps names unique regardless of capitals', async () => {
    const a = await person(),
      b = await person();
    expect((await call('POST', '/me/profile', a.token, { ...valid, handle: 'unique.name' })).statusCode).toBe(201);
    const res = await call('POST', '/me/profile', b.token, { ...valid, handle: 'Unique.Name' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'handle_taken', message: 'That name is taken. Try another.' });
  });

  it('allows one profile per person', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'only.once' });
    const res = await call('POST', '/me/profile', p.token, { ...valid, handle: 'twice.now' });
    expect(res.json<Body>().error).toBe('profile_exists');
  });

  it('needs 1 to 8 known fields and a known country', async () => {
    const p = await person();
    const nine = [
      'imports-customs',
      'study-abroad',
      'visas-immigration',
      'jobs-careers',
      'cars-vehicles',
      'housing-renting',
      'money-tax',
      'travel',
      'fitness',
    ];
    for (const body of [
      { ...valid, fields: [] },
      { ...valid, fields: nine },
      { ...valid, fields: ['astrology'] },
      { ...valid, fields: ['travel', 'travel'] },
      { ...valid, country: 'ZZ' },
      { ...valid, country: 'in' },
    ]) {
      const res = await call('POST', '/me/profile', p.token, { ...body, handle: 'field.check' });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call('GET', '/me', p.token)).json<Body>().profile).toBeNull();
  });
});

describe('editing a profile', () => {
  it('replaces fields and country', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'editor' });
    const res = await call('PATCH', '/me/profile', p.token, { country: 'AE', fields: ['travel'] });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>().profile).toMatchObject({
      country: { code: 'AE', name: 'United Arab Emirates' },
      fields: [{ slug: 'travel', name: 'Travel' }],
    });
  });

  it('allows a name change once a week, timed by the database clock', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'first.name' });
    expect((await call('PATCH', '/me/profile', p.token, { handle: 'second.name' })).statusCode).toBe(200);
    const { rows } = await t.owner.query<{ at: Date }>(
      "SELECT handle_changed_at + interval '7 days' AS at FROM app.profiles WHERE id = $1",
      [p.id],
    );
    const tooSoon = await call('PATCH', '/me/profile', p.token, { handle: 'third.name' });
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json()).toMatchObject({ error: 'handle_change_too_soon', availableAt: rows[0]?.at.toISOString() });
    // A week (and a minute) later, by moving the recorded change back. The
    // database's own rule refuses to let anyone edit that time, so the test
    // skips triggers for this one statement (superuser only).
    await t.owner.query('BEGIN');
    await t.owner.query('SET LOCAL session_replication_role = replica');
    await t.owner.query(
      "UPDATE app.profiles SET handle_changed_at = now() - interval '7 days 1 minute' WHERE id = $1",
      [p.id],
    );
    await t.owner.query('COMMIT');
    expect((await call('PATCH', '/me/profile', p.token, { handle: 'third.name' })).statusCode).toBe(200);
  });

  it('enforces the weekly name rule in the database too, and stamps the time itself', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'db.first' });
    const rename = (handle: string, changedAt: string | null) =>
      t.database.withUser(p.id, q =>
        q.query('UPDATE app.profiles SET handle = $2, handle_changed_at = $3 WHERE id = $1', [p.id, handle, changedAt]),
      );
    // First change: allowed, and the database ignores the made-up time it was sent.
    await rename('db.second', '2000-01-01T00:00:00Z');
    const { rows } = await t.owner.query<{ recent: boolean }>(
      "SELECT handle_changed_at > now() - interval '1 minute' AS recent FROM app.profiles WHERE id = $1",
      [p.id],
    );
    expect(rows[0]?.recent).toBe(true);
    // Second change the same week: refused even when claiming the last change was long ago.
    await expect(rename('db.third', '2000-01-01T00:00:00Z')).rejects.toMatchObject({ code: '23514' });
  });

  it('says to set up a profile first if there is none', async () => {
    const p = await person();
    expect((await call('PATCH', '/me/profile', p.token, { country: 'IN' })).json<Body>().error).toBe('no_profile');
  });
});

describe('looking people up', () => {
  it('shows a public profile to anyone, without private details', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'public.one' });
    const res = await call('GET', '/profiles/Public.One');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(must(res.json<Body>().profile, 'a profile')).sort()).toEqual([
      'country',
      'fields',
      'handle',
      'joined',
    ]);
    expect(res.body).not.toContain(p.id);
  });

  it('reports name availability to signed-in people only', async () => {
    const owner = await person(),
      other = await person();
    await call('POST', '/me/profile', owner.token, { ...valid, handle: 'taken.name' });
    expect((await call('GET', '/handles/taken.name')).statusCode).toBe(401);
    expect((await call('GET', '/handles/taken.name', other.token)).json()).toMatchObject({
      available: false,
      reason: 'taken',
    });
    expect((await call('GET', '/handles/taken.name', owner.token)).json()).toMatchObject({ available: true });
    expect((await call('GET', '/handles/free.name', other.token)).json()).toMatchObject({ available: true });
    expect((await call('GET', '/handles/a..b', other.token)).json()).toMatchObject({
      available: false,
      reason: 'dots',
    });
  });

  it('serves the field and country lists', async () => {
    const res = await call('GET', '/meta');
    expect(res.json<Body>().fields).toHaveLength(20);
    expect(res.json<Body>().countries).toHaveLength(250);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('deleting an account', () => {
  it('requires explicit confirmation', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'not.yet' });
    expect((await call('DELETE', '/me', p.token, {})).statusCode).toBe(400);
    expect((await call('GET', '/me', p.token)).json<Body>().profile).not.toBeNull();
  });

  it('removes every row and the sign-in, and the old token stops working at once', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'leaving' });
    const res = await call('DELETE', '/me', p.token, { confirm: true });
    expect(res.statusCode).toBe(204);
    expect(admin.deleted).toContain(p.id);
    const left = await t.owner.query(
      `SELECT (SELECT count(*) FROM app.profiles WHERE id = $1)::int AS profiles,
              (SELECT count(*) FROM app.profile_fields WHERE profile_id = $1)::int AS fields`,
      [p.id],
    );
    expect(left.rows[0]).toEqual({ profiles: 0, fields: 0 });
    // The token is still cryptographically valid for up to an hour; it must not be accepted.
    expect((await call('GET', '/me', p.token)).statusCode).toBe(401);
    expect((await call('POST', '/me/profile', p.token, { ...valid, handle: 'back.again' })).statusCode).toBe(401);
    // Only a keyed hash is remembered, never the id.
    const revoked = await t.owner.query<{ subject_hash: string }>('SELECT subject_hash FROM app.revoked_subjects');
    expect(revoked.rows.map(r => r.subject_hash)).toContain(subjectHash(p.id, KEY));
    expect(JSON.stringify(revoked.rows)).not.toContain(p.id);
  });

  it('leaves nothing pending when Supabase removes the sign-in straight away', async () => {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: 'clean.exit' });
    expect((await call('DELETE', '/me', p.token, { confirm: true })).statusCode).toBe(204);
    const { rows } = await t.owner.query('SELECT 1 FROM app.pending_auth_deletions WHERE user_id = $1', [p.id]);
    expect(rows).toHaveLength(0);
  });
});

describe('when Supabase fails to remove the sign-in', () => {
  async function deleteWithFailure() {
    const p = await person();
    await call('POST', '/me/profile', p.token, { ...valid, handle: `fail.${p.id.slice(0, 6)}` });
    admin.failNextDelete();
    const res = await call('DELETE', '/me', p.token, { confirm: true });
    return { p, res };
  }
  const job = () =>
    completePendingDeletions({ db: t.database, authAdmin: admin, subjectKey: KEY, log: { warn: () => {} } });
  // Each test starts with nothing pending, so the job's counts are this test's alone.
  beforeEach(async () => {
    await t.owner.query('DELETE FROM app.pending_auth_deletions');
  });

  it('still tells the person their account is deleted, and records the sign-in as pending', async () => {
    const { p, res } = await deleteWithFailure();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      status: 'finishing',
      message:
        'Your account is deleted. Removing your sign-in is taking longer than usual; it will finish automatically.',
    });
    expect(admin.deleted).not.toContain(p.id);
    const { rows } = await t.owner.query('SELECT attempts FROM app.pending_auth_deletions WHERE user_id = $1', [p.id]);
    expect(rows).toEqual([{ attempts: 0 }]);
  });

  it('keeps refusing the account while removal is pending, even after the 2-hour lockout ends', async () => {
    const { p } = await deleteWithFailure();
    await t.owner.query('DELETE FROM app.revoked_subjects WHERE subject_hash = $1', [subjectHash(p.id, KEY)]);
    // A fresh token for the same person, as a refresh would give while Supabase still has them.
    const fresh = await issuer.sign({}, { sub: p.id });
    expect((await call('GET', '/me', fresh)).statusCode).toBe(401);
    expect((await call('POST', '/me/profile', fresh, { ...valid, handle: 'resurrected' })).statusCode).toBe(401);
  });

  it('refuses, in the database itself, a profile for a sign-in that is pending removal', async () => {
    const { p } = await deleteWithFailure();
    await expect(
      t.database.withUser(p.id, async q => {
        await q.query(
          "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, 'sneaky.back', 'IN', now())",
          [p.id],
        );
        await q.query("INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'travel')", [p.id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is finished automatically by the retry job, which then forgets the id', async () => {
    const { p } = await deleteWithFailure();
    expect(await job()).toEqual({ completed: 1, failed: 0 });
    expect(admin.deleted).toContain(p.id);
    const pending = await t.owner.query('SELECT 1 FROM app.pending_auth_deletions WHERE user_id = $1', [p.id]);
    expect(pending.rows).toHaveLength(0);
    // Tokens issued before Supabase removed the person are still refused for the next 2 hours.
    const revoked = await t.owner.query(
      "SELECT until > now() + interval '110 minutes' AS fresh FROM app.revoked_subjects WHERE subject_hash = $1",
      [subjectHash(p.id, KEY)],
    );
    expect(revoked.rows).toEqual([{ fresh: true }]);
    expect((await call('GET', '/me', p.token)).statusCode).toBe(401);
  });

  it('backs off after a failed retry instead of hammering Supabase', async () => {
    const { p } = await deleteWithFailure();
    admin.failNextDelete();
    expect(await job()).toEqual({ completed: 0, failed: 1 });
    const { rows } = await t.owner.query(
      'SELECT attempts, next_attempt_at > now() AS later FROM app.pending_auth_deletions WHERE user_id = $1',
      [p.id],
    );
    expect(rows).toEqual([{ attempts: 1, later: true }]);
    // Not due yet: running the job again does nothing.
    expect(await job()).toEqual({ completed: 0, failed: 0 });
    expect(admin.deleted).not.toContain(p.id);
  });

  it('can also be finished by the person retrying the deletion themselves', async () => {
    const { p } = await deleteWithFailure();
    expect((await call('DELETE', '/me', p.token, { confirm: true })).statusCode).toBe(204);
    expect(admin.deleted).toContain(p.id);
    const { rows } = await t.owner.query('SELECT 1 FROM app.pending_auth_deletions WHERE user_id = $1', [p.id]);
    expect(rows).toHaveLength(0);
  });
});

describe('the database itself', () => {
  it('stops one person editing or deleting another, even if the API forgot to check', async () => {
    const a = await person(),
      b = await person();
    await call('POST', '/me/profile', a.token, { ...valid, handle: 'victim' });
    const changed = await t.database.withUser(b.id, async q => {
      const u = await q.query("UPDATE app.profiles SET country = 'US' WHERE id = $1", [a.id]);
      const d = await q.query('DELETE FROM app.profiles WHERE id = $1', [a.id]);
      const f = await q.query('DELETE FROM app.profile_fields WHERE profile_id = $1', [a.id]);
      return [u.rowCount, d.rowCount, f.rowCount];
    });
    expect(changed).toEqual([0, 0, 0]);
    await expect(
      t.database.withUser(b.id, q =>
        q.query(
          "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, 'impostor', 'IN', now())",
          [a.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces the name rule, 18+ and field count even for direct inserts', async () => {
    const p = await person();
    const insert = (handle: string, adult: string | null) =>
      t.database.withUser(p.id, q =>
        q.query('INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, $2, $3, $4)', [
          p.id,
          handle,
          'IN',
          adult,
        ]),
      );
    await expect(insert('Admin', '2026-10-17')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('fine.name', null)).rejects.toMatchObject({ code: '23502' });
    // A profile with no fields is refused when the transaction commits.
    await expect(insert('fine.name', '2026-10-17')).rejects.toMatchObject({ code: '23514' });
  });

  it('agrees with the API on every name example', async () => {
    for (const [handle, problem] of handleExamples) {
      const { rows } = await t.api.query<{ ok: boolean }>('SELECT app.is_valid_handle($1) AS ok', [handle]);
      expect(must(rows[0]).ok, handle).toBe(problem === null);
    }
  });
});
