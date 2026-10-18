import { createECDH } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { createLimiter } from '../src/push-sender.ts';
import { encryptPush, isPushService, privateKeyText, vapidHeader } from '../src/push.ts';

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

describe('push message encryption', () => {
  it('reproduces RFC 8291’s worked example byte for byte', () => {
    const body = encryptPush(
      Buffer.from('When I grow up, I want to be a watermelon'),
      b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      b('BTBZMqHH6r4Tts7J_aSIgg'),
      { salt: b('DGv6ra1nlYgDCS1FRnbzlw'), senderPrivateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
      + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
      + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('uses a fresh salt and key for every message', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const one = encryptPush(Buffer.from('hi'), ua.getPublicKey(), auth);
    const two = encryptPush(Buffer.from('hi'), ua.getPublicKey(), auth);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false);
  });
});

describe('VAPID', () => {
  it('signs for the push service’s origin, as us, for at most a day', async () => {
    const keys = createECDH('prime256v1');
    keys.generateKeys();
    const now = 1_800_000_000;
    const header = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', {
      publicKey: keys.getPublicKey().toString('base64url'), privateKey: privateKeyText(keys), subject: 'https://graphinity.pages.dev',
    }, now);
    const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(publicKey).toBe(keys.getPublicKey().toString('base64url'));
    expect(decodeProtectedHeader(token ?? '')).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = decodeJwt(token ?? '');
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://graphinity.pages.dev' });
    expect((claims.exp ?? 0) - now).toBeLessThanOrEqual(24 * 3600);
  });
});

describe('which addresses we push to', () => {
  it('only the browsers’ push services, over https', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect(isPushService(ok), ok).toBe(true);
    }
    for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.example/x',
      'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x', 'not a url', 'https://push.apple.com.evil.example/x']) {
      expect(isPushService(bad), bad).toBe(false);
    }
  });
});

describe('sending pushes a few at a time', () => {
  it('never runs more than the limit at once, and runs them all', async () => {
    const limit = createLimiter(2);
    let running = 0, most = 0, done = 0;
    await Promise.all(Array.from({ length: 10 }, () => limit(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise(r => setTimeout(r, 5));
      running -= 1;
      done += 1;
    })));
    expect([most, done]).toEqual([2, 10]);
  });
});

