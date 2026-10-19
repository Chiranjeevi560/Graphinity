// Web push: subscribing devices, and what the server actually sends.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPushSender } from '../src/push-sender.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';
import { privateKeyText } from '../src/push.ts';

const server = createECDH('prime256v1');
server.generateKeys();
const vapid = {
  publicKey: server.getPublicKey().toString('base64url'),
  privateKey: privateKeyText(server),
  subject: 'https://graphinity.pages.dev',
};

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { vapidPublicKey: vapid.publicKey });
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `push.${String(names)}`,
        country: 'IN',
        fields: ['travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  return p;
}

/** A browser's side of a subscription: its key pair and auth secret. */
function device(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`) {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint,
    keys,
    auth,
    body: { endpoint, keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

/** What the browser does on receipt: decrypt (RFC 8291). */
function decrypt(body: Buffer, d: ReturnType<typeof device>): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderKey = body.subarray(21, 21 + idLength);
  const shared = d.keys.computeSecret(senderKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), d.keys.getPublicKey(), senderKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, d.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString();
}

describe('subscribing a device', () => {
  it('gives browsers the public key', async () => {
    expect((await h.call('GET', '/push/key')).json()).toEqual({ publicKey: vapid.publicKey });
  });

  it('accepts only the browsers’ push services', async () => {
    const p = await member();
    for (const endpoint of ['https://evil.example/hook', 'http://fcm.googleapis.com/x', 'https://127.0.0.1/x']) {
      const res = await h.call('PUT', '/me/push', p.token, device(endpoint).body);
      expect(res.statusCode, endpoint).toBe(400);
      expect(res.json<Body>().error).toBe('not_a_push_service');
    }
    expect((await h.call('PUT', '/me/push', p.token, device().body)).json()).toEqual({ push: { on: true } });
  });

  it('never sends one person’s notifications to a device another account registered', async () => {
    const a = await member(),
      b = await member();
    const shared = device();
    expect((await h.call('PUT', '/me/push', a.token, shared.body)).statusCode).toBe(200);
    // Same browser again for the same person: fine.
    expect((await h.call('PUT', '/me/push', a.token, shared.body)).statusCode).toBe(200);
    const res = await h.call('PUT', '/me/push', b.token, shared.body);
    expect(res.statusCode).toBe(409);
    expect(res.json<Body>().error).toBe('device_in_use');
    // Each account learns only whether the device is its own.
    expect((await h.call('POST', '/me/push/status', a.token, { endpoint: shared.endpoint })).json()).toEqual({
      push: { on: true },
    });
    expect((await h.call('POST', '/me/push/status', b.token, { endpoint: shared.endpoint })).json()).toEqual({
      push: { on: false },
    });
    expect((await h.call('POST', '/me/push/status', undefined, { endpoint: shared.endpoint })).statusCode).toBe(401);
    expect((await h.call('POST', '/me/push/status', a.token, { endpoint: shared.endpoint, extra: 1 })).statusCode).toBe(
      400,
    );
    // And b can't remove a's device.
    await h.call('DELETE', '/me/push', b.token, { endpoint: shared.endpoint });
    const { rows } = await h.t.owner.query('SELECT 1 FROM app.push_subscriptions WHERE endpoint = $1', [
      shared.endpoint,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('allows 10 devices per person, and turning one off', async () => {
    const p = await member();
    const devices = Array.from({ length: 10 }, () => device());
    for (const d of devices) expect((await h.call('PUT', '/me/push', p.token, d.body)).statusCode).toBe(200);
    expect((await h.call('PUT', '/me/push', p.token, device().body)).json<Body>().error).toBe('too_many_devices');
    expect((await h.call('DELETE', '/me/push', p.token, { endpoint: must(devices[0]).endpoint })).json()).toEqual({
      push: { on: false },
    });
    expect((await h.call('POST', '/me/push/status', p.token, { endpoint: must(devices[0]).endpoint })).json()).toEqual({
      push: { on: false },
    });
    expect((await h.call('PUT', '/me/push', p.token, device().body)).statusCode).toBe(200);
  });
});

describe('sending', () => {
  it('sends each of the person’s devices an encrypted message only they can read, and drops gone devices', async () => {
    const asker = await member(),
      other = await member();
    const phone = device(),
      laptop = device('https://updates.push.services.mozilla.com/wpush/v2/abc'),
      theirs = device();
    await h.call('PUT', '/me/push', asker.token, phone.body);
    await h.call('PUT', '/me/push', asker.token, laptop.body);
    await h.call('PUT', '/me/push', other.token, theirs.body);
    const q = must(
      (
        await h.call('POST', '/questions', asker.token, {
          title: 'Is the old town walkable from the station?',
          field: 'travel',
        })
      ).json<{ question: { id: string } }>().question.id,
    );

    const sent: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    const warnings: object[] = [];
    const send = createPushSender({
      db: h.t.database,
      vapid,
      now: () => Date.now(),
      log: {
        warn: o => {
          warnings.push(o);
        },
      },
      fetch: ((url: string, init: RequestInit) => {
        sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
        // The laptop's subscription has expired.
        return Promise.resolve(new Response(null, { status: url === laptop.endpoint ? 410 : 201 }));
      }) as unknown as typeof fetch,
    });
    await send(asker.id, { type: 'answered', questionId: q });

    expect(sent.map(s => s.url).sort()).toEqual([phone.endpoint, laptop.endpoint].sort());
    const toPhone = must(sent.find(s => s.url === phone.endpoint));
    expect(toPhone.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '86400' });
    expect(toPhone.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(JSON.parse(decrypt(toPhone.body, phone))).toEqual({
      title: 'New answer to your question',
      body: 'Is the old town walkable from the station?',
      questionId: q,
    });
    // Someone else's key can't read it.
    expect(() => decrypt(toPhone.body, theirs)).toThrow();
    // The expired one is removed; the working one stays.
    const left = await h.t.owner.query<{ endpoint: string }>(
      'SELECT endpoint FROM app.push_subscriptions WHERE endpoint = ANY($1)',
      [[phone.endpoint, laptop.endpoint]],
    );
    expect(left.rows.map(r => r.endpoint)).toEqual([phone.endpoint]);
    expect(warnings).toEqual([]);
  });
});

describe('a server without push keys', () => {
  it('says notifications aren’t available, rather than taking subscriptions it can’t use', async () => {
    const off = await startApp(() => Date.now());
    try {
      const p = await off.person();
      expect((await off.call('GET', '/push/key')).json<Body>().error).toBe('push_off');
      const res = await off.call('PUT', '/me/push', p.token, device().body);
      expect(res.statusCode).toBe(404);
      expect(res.json<Body>().error).toBe('push_off');
    } finally {
      await off.close();
    }
  });
});
