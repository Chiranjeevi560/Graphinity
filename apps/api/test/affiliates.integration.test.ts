// Affiliate referrals (ADR 0036) through the real server and Postgres as the restricted role: off by default; only
// the owner adds programs and links; a link can't send anyone off the program's site; clicks are counted with no
// person; a click token only with the reader's yes; sales only with the program's signature, once per order.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { DISCLOSURE, postbackKey, signPostback } from '../src/routes/affiliates.ts';
import { sweepAffiliateTokens, TOKEN_DAYS } from '../src/affiliates/sweep.ts';
import { IP_HASH_KEY, startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let on = false;
let n = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { affiliatesEnabled: () => on });
  return h.close;
});

const setOn = async (value: boolean) => {
  on = value;
  await h.t.owner.query("UPDATE app.feature_flags SET enabled = $1 WHERE name = 'affiliates'", [value]);
};
async function member() {
  const p = await h.person();
  n += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `aff.${String(n)}`,
        country: 'IN',
        fields: ['phones-gadgets'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  return p;
}
async function owner() {
  const p = await member();
  await h.t.owner.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [p.id]);
  return p;
}
async function question(asker: { token: string }) {
  const res = await h.call('POST', '/questions', asker.token, {
    title: `Which phone case lasted you longest, round ${String(n)}?`,
    field: 'phones-gadgets',
  });
  return res.json<{ question: { id: string } }>().question.id;
}
async function programAndLink(o: { token: string }, q: string) {
  const p = await h.call('POST', '/owner/affiliates/programs', o.token, {
    name: 'Case Shop',
    host: 'shop.example.in',
    tagParam: 'tag',
    tagValue: 'graphinity-21',
    clickParam: 'subid',
  });
  expect(p.statusCode).toBe(201);
  const program = p.json<{ program: { id: string; postbackKey: string } }>().program;
  const l = await h.call('POST', '/owner/affiliates/links', o.token, {
    program: program.id,
    question: q,
    label: 'Rugged case at Case Shop',
    destination: 'https://www.shop.example.in/cases/rugged?colour=black',
  });
  expect(l.statusCode).toBe(201);
  return { program, token: l.json<{ link: { token: string } }>().link.token };
}

describe('affiliate links', () => {
  it('are off by default: nothing to make, follow or report, and no links shown', async () => {
    const o = await owner();
    const q = await question(o);
    expect(
      (
        await h.call('POST', '/owner/affiliates/programs', o.token, {
          name: 'X Shop',
          host: 'x.example.in',
          tagParam: 'tag',
          tagValue: 't',
        })
      ).statusCode,
    ).toBe(404);
    expect((await h.call('GET', `/questions/${q}/affiliate-links`)).json()).toEqual({
      links: [],
      disclosure: DISCLOSURE,
    });
    expect((await h.call('POST', `/affiliates/go/${randomUUID()}`)).statusCode).toBe(404);
    // The database refuses a program while its switch is off, even from the owner.
    await h.t.database.withUser(o.id, async q2 => {
      await expect(
        q2.query(
          "INSERT INTO app.affiliate_programs (name, host, tag_param, tag_value) VALUES ('X Shop', 'x.example.in', 'tag', 't')",
        ),
      ).rejects.toThrow();
    });
  });

  it('only the owner adds them, and a link never leaves the program’s site', async () => {
    await setOn(true);
    try {
      const someone = await member();
      expect(
        (
          await h.call('POST', '/owner/affiliates/programs', someone.token, {
            name: 'Sneaky',
            host: 'evil.example',
            tagParam: 'tag',
            tagValue: 't',
          })
        ).statusCode,
      ).toBe(403);
      const o = await owner();
      const q = await question(o);
      const { program } = await programAndLink(o, q);
      for (const destination of [
        'https://evil.example/cases',
        'https://shop.example.in.evil.example/x',
        'https://evil.example@shop.example.in/x',
        'https://notshop.example.in/x',
      ]) {
        const res = await h.call('POST', '/owner/affiliates/links', o.token, {
          program: program.id,
          question: q,
          label: 'Case',
          destination,
        });
        expect(res.statusCode, destination).toBe(400);
      }
      // Straight to the database as someone else: refused.
      await h.t.database.withUser(someone.id, async q2 => {
        await expect(
          q2.query(
            "INSERT INTO app.affiliate_links (program_id, question_id, label, destination) SELECT id, $1, 'Case', 'https://shop.example.in/x' FROM app.affiliate_programs LIMIT 1",
            [q],
          ),
        ).rejects.toThrow();
      });
    } finally {
      await setOn(false);
    }
  });

  it('show labelled, count clicks with no person, and add a click token only with the reader’s yes', async () => {
    await setOn(true);
    try {
      const o = await owner();
      const q = await question(o);
      const { token } = await programAndLink(o, q);
      const shown = (await h.call('GET', `/questions/${q}/affiliate-links`)).json<{
        links: Array<{ token: string; label: string }>;
        disclosure: string;
      }>();
      expect(shown).toEqual({ links: [{ token, label: 'Rugged case at Case Shop' }], disclosure: DISCLOSURE });

      // A visitor: the tag, no click token.
      const visitor = (await h.call('POST', `/affiliates/go/${token}`)).json<{ url: string }>();
      const url = new URL(visitor.url);
      expect(url.host).toBe('www.shop.example.in');
      expect(url.searchParams.get('tag')).toBe('graphinity-21');
      expect(url.searchParams.get('colour')).toBe('black');
      expect(url.searchParams.has('subid')).toBe(false);

      // Signed in without the yes, or with it but sending Sec-GPC: still none.
      const reader = await member();
      expect(
        new URL(
          (await h.call('POST', `/affiliates/go/${token}`, reader.token)).json<{ url: string }>().url,
        ).searchParams.has('subid'),
      ).toBe(false);
      await h.t.owner.query(
        "INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version) VALUES ($1, 'affiliate_optimization', true, 1)",
        [reader.id],
      );
      const gpc = await h.app.inject({
        method: 'POST',
        url: `/affiliates/go/${token}`,
        headers: { authorization: `Bearer ${reader.token}`, 'sec-gpc': '1' },
      });
      expect(new URL(gpc.json<{ url: string }>().url).searchParams.has('subid')).toBe(false);
      const consented = new URL(
        (await h.call('POST', `/affiliates/go/${token}`, reader.token)).json<{ url: string }>().url,
      );
      expect(consented.searchParams.get('subid')).toMatch(/^[0-9a-f-]{36}$/);

      const clicks = await h.t.owner.query<{ clicks: number }>(
        'SELECT c.clicks FROM app.affiliate_clicks c JOIN app.affiliate_links l ON l.id = c.link_id WHERE l.token = $1',
        [token],
      );
      expect(must(clicks.rows[0]).clicks).toBe(4);
      // The token table names a link and a time: no person, no address.
      const columns = await h.t.owner.query<{ c: string }>(
        "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'affiliate_click_tokens' ORDER BY 1",
      );
      expect(columns.rows.map(r => r.c)).toEqual(['created_at', 'link_id', 'token']);
    } finally {
      await setOn(false);
    }
  });

  it('count a sale only with the program’s signature, once per order, tied to its click', async () => {
    await setOn(true);
    try {
      const o = await owner();
      const q = await question(o);
      const { program, token } = await programAndLink(o, q);
      expect(program.postbackKey).toBe(postbackKey(IP_HASH_KEY, program.id));
      const reader = await member();
      await h.t.owner.query(
        "INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version) VALUES ($1, 'affiliate_optimization', true, 1)",
        [reader.id],
      );
      const clickToken = must(
        new URL(
          (await h.call('POST', `/affiliates/go/${token}`, reader.token)).json<{ url: string }>().url,
        ).searchParams.get('subid'),
      );
      const sale = { program: program.id, orderRef: 'ORD-1001', commissionPaise: 4500, clickToken };
      const post = (body: object) => h.call('POST', '/affiliates/postback', undefined, body);
      expect((await post({ ...sale, signature: '0'.repeat(64) })).statusCode).toBe(401);
      // Signed for another amount: refused.
      expect(
        (await post({ ...sale, signature: signPostback(IP_HASH_KEY, { ...sale, commissionPaise: 9999 }) })).statusCode,
      ).toBe(401);
      const signed = { ...sale, signature: signPostback(IP_HASH_KEY, sale) };
      expect((await post(signed)).json()).toEqual({ counted: true });
      expect((await post(signed)).json()).toEqual({ counted: false });
      const rows = await h.t.owner.query<{ commission: number; link: string | null }>(
        'SELECT commission_paise AS commission, link_id::text AS link FROM app.affiliate_conversions WHERE order_ref = $1',
        ['ORD-1001'],
      );
      expect(rows.rows).toHaveLength(1);
      expect(must(rows.rows[0]).commission).toBe(4500);
      expect(must(rows.rows[0]).link).not.toBeNull();
    } finally {
      await setOn(false);
    }
  });

  it('refuse what doesn’t exist or isn’t yours, and stop at once when a link is removed', async () => {
    await setOn(true);
    try {
      const o = await owner();
      const q = await question(o);
      const { program, token } = await programAndLink(o, q);
      const someone = await member();
      // An unknown program or question.
      expect(
        (
          await h.call('POST', '/owner/affiliates/links', o.token, {
            program: randomUUID(),
            question: q,
            label: 'Case',
            destination: 'https://shop.example.in/x',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await h.call('POST', '/owner/affiliates/links', o.token, {
            program: program.id,
            question: '999999999',
            label: 'Case',
            destination: 'https://shop.example.in/x',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await h.call('POST', '/owner/affiliates/links', someone.token, {
            program: program.id,
            question: q,
            label: 'Case',
            destination: 'https://shop.example.in/x',
          })
        ).statusCode,
      ).toBe(403);
      // Removing: not by someone else; once by the owner; then the link is gone everywhere.
      expect((await h.call('DELETE', `/owner/affiliates/links/${token}`, someone.token)).statusCode).toBe(403);
      expect((await h.call('DELETE', `/owner/affiliates/links/${token}`, o.token)).statusCode).toBe(204);
      expect((await h.call('DELETE', `/owner/affiliates/links/${token}`, o.token)).statusCode).toBe(404);
      expect((await h.call('POST', `/affiliates/go/${token}`)).statusCode).toBe(404);
      expect((await h.call('GET', `/questions/${q}/affiliate-links`)).json<{ links: unknown[] }>().links).toEqual([]);
      // A sale for a program that doesn't exist, correctly signed for it: nothing to count.
      const ghost = { program: randomUUID(), orderRef: 'ORD-9', commissionPaise: 1 };
      expect(
        (
          await h.call('POST', '/affiliates/postback', undefined, {
            ...ghost,
            signature: signPostback(IP_HASH_KEY, ghost),
          })
        ).statusCode,
      ).toBe(404);
      // Without a click token: counted, tied to no link.
      const plain = { program: program.id, orderRef: 'ORD-10', commissionPaise: 100 };
      expect(
        (
          await h.call('POST', '/affiliates/postback', undefined, {
            ...plain,
            signature: signPostback(IP_HASH_KEY, plain),
          })
        ).json(),
      ).toEqual({
        counted: true,
      });
    } finally {
      await setOn(false);
    }
    // Off again: nothing to report to.
    expect(
      (
        await h.call('POST', '/affiliates/postback', undefined, {
          program: randomUUID(),
          orderRef: 'x',
          commissionPaise: 1,
          signature: '0'.repeat(64),
        })
      ).statusCode,
    ).toBe(404);
    expect((await h.call('POST', '/owner/affiliates/links', undefined, {})).statusCode).toBe(401);
  });

  it('forget click tokens after 90 days', async () => {
    const link = must(
      (await h.t.owner.query<{ id: string }>('SELECT id::text FROM app.affiliate_links LIMIT 1')).rows[0],
    ).id;
    await h.t.owner.query(
      `INSERT INTO app.affiliate_click_tokens (link_id, created_at) VALUES ($1, now() - make_interval(days => $2)), ($1, now())`,
      [link, TOKEN_DAYS + 1],
    );
    const before = Number(
      must((await h.t.owner.query<{ n: string }>('SELECT count(*) AS n FROM app.affiliate_click_tokens')).rows[0]).n,
    );
    expect(await sweepAffiliateTokens(h.t.database)).toBe(1);
    const after = Number(
      must((await h.t.owner.query<{ n: string }>('SELECT count(*) AS n FROM app.affiliate_click_tokens')).rows[0]).n,
    );
    expect(after).toBe(before - 1);
  });
});
