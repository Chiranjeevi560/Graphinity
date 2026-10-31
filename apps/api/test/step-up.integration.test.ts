// Dangerous actions and a recent sign-in, through the real server (ADR 0026).
import { describe, expect, it } from 'vitest';
import { signedInAt } from '../src/auth.ts';
import { startApp } from './helpers/app.ts';
import type { Body } from './helpers/must.ts';

describe('signedInAt', () => {
  it('takes the newest real sign-in and ignores refreshes', () => {
    expect(
      signedInAt([
        { method: 'oauth', timestamp: 100 },
        { method: 'oauth', timestamp: 200 },
        { method: 'token_refresh', timestamp: 900 },
      ]),
    ).toBe(200);
  });
  it('says nothing when the token says nothing usable', () => {
    expect(signedInAt(undefined)).toBeNull();
    expect(signedInAt([{ method: 'token_refresh', timestamp: 900 }])).toBeNull();
    expect(signedInAt([{ method: 'oauth', timestamp: '900' }])).toBeNull();
  });
});

describe('step-up', () => {
  it('while on, refuses a stale or missing sign-in and allows a fresh one; while off, allows all', async () => {
    let on = true;
    const h = await startApp(() => Date.now(), { stepUpEnabled: () => on });
    try {
      const p = await h.person();
      await h.call('POST', '/me/profile', p.token, {
        handle: 'stepup.a',
        country: 'IN',
        fields: ['travel'],
        adult: true,
      });
      const now = Math.floor(Date.now() / 1000);
      const token = (amr: unknown) => h.issuer.sign({ amr }, { sub: p.id });
      const exportWith = async (amr: unknown) => h.call('GET', '/me/data-export', await token(amr));

      const stale = await exportWith([{ method: 'oauth', timestamp: now - 301 }]);
      expect(stale.statusCode).toBe(403);
      expect(stale.json<Body>().error).toBe('reauth_required');
      expect((await exportWith(undefined)).statusCode).toBe(403);
      // A refresh just now doesn't make an old sign-in recent.
      expect(
        (
          await exportWith([
            { method: 'oauth', timestamp: now - 3000 },
            { method: 'token_refresh', timestamp: now },
          ])
        ).statusCode,
      ).toBe(403);
      expect((await exportWith([{ method: 'oauth', timestamp: now - 10 }])).statusCode).toBe(200);
      // Not every route: ordinary reading isn't dangerous.
      expect((await h.call('GET', '/me', await token(undefined))).statusCode).toBe(200);
      const del = await h.call('DELETE', '/me', await token([{ method: 'oauth', timestamp: now - 301 }]), {
        confirm: true,
      });
      expect(del.json<Body>().error).toBe('reauth_required');
      on = false;
      expect((await exportWith(undefined)).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });
});
