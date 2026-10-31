import { describe, expect, it } from 'vitest';
import {
  AGENT,
  buildBidRequest,
  CONTENT_CATEGORY,
  deviceType,
  DEVICE,
  parseBidResponse,
  SENSITIVE_FIELDS,
  TMAX_MS,
  truncateIp,
  type Offer,
} from '../src/ads/openrtb.ts';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURES,
  createExchange,
  MAX_IN_FLIGHT,
  type Fetcher,
} from '../src/ads/exchange.ts';

const offer = (over: Partial<Offer> = {}): Offer => ({
  placement: 'question',
  slots: 1,
  floorCpm: 20,
  currency: 'INR',
  fields: ['travel'],
  path: '/q/12/ferry-to-the-islands?utm_term=x#answers',
  country: 'IN',
  ip: '203.0.113.77',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148',
  partner: null,
  test: false,
  site: 'example.pages.dev',
  ...over,
});

describe('what a bid request carries', () => {
  it('without partner consent: the page’s categories and a coarse device, nothing of the person', () => {
    const r = buildBidRequest(offer());
    const json = JSON.stringify(r);
    expect(r).toMatchObject({
      tmax: TMAX_MS,
      at: 2,
      cur: ['INR'],
      imp: [{ id: '1', tagid: 'question', bidfloor: 20, bidfloorcur: 'INR', secure: 1 }],
      site: {
        domain: 'example.pages.dev',
        cattax: 7,
        cat: [CONTENT_CATEGORY.travel],
        page: 'https://example.pages.dev/q/12/ferry-to-the-islands',
      },
      device: { devicetype: DEVICE.phone },
      regs: { coppa: 0, gdpr: 0 },
    });
    expect(r.user).toBeUndefined();
    expect(json).not.toContain('203.0.113');
    expect(json).not.toContain('iPhone OS');
    expect(json).not.toContain('utm_term');
  });

  it('with consent: segments, a rotating EID, and the address cut to /24', () => {
    const r = buildBidRequest(
      offer({ partner: { eid: 'eid-1', crossDevice: false, interests: ['travel', 'money-tax'] }, country: 'DE' }),
    );
    expect(r.device).toMatchObject({ ip: '203.0.113.0' });
    expect(r.user).toEqual({
      data: [
        {
          id: 'example.pages.dev',
          name: 'example.pages.dev',
          segment: [{ id: '719' }, { id: '534' }],
          ext: { segtax: 4 },
        },
      ],
      eids: [
        { source: 'example.pages.dev', inserter: 'example.pages.dev', uids: [{ id: 'eid-1', atype: AGENT.browser }] },
      ],
    });
    expect(r.regs).toEqual({ coppa: 0, gdpr: 1 });
    const person = buildBidRequest(offer({ partner: { eid: 'e', crossDevice: true, interests: [] } }));
    expect(
      (person.user as { data?: unknown; eids: Array<{ uids: Array<{ atype: number }> }> }).eids[0]?.uids[0]?.atype,
    ).toBe(AGENT.person);
    expect((person.user as { data?: unknown }).data).toBeUndefined();
  });

  it('never carries a sensitive topic, as a category or a segment', () => {
    for (const f of SENSITIVE_FIELDS) {
      const r = buildBidRequest(offer({ fields: [f], partner: { eid: 'e', crossDevice: false, interests: [f] } }));
      expect((r.site as { cat?: unknown }).cat).toBeUndefined();
      expect((r.user as { data?: unknown }).data).toBeUndefined();
    }
  });

  it('cuts addresses to /24 or /48, and drops anything that isn’t one', () => {
    expect(truncateIp('192.168.1.200')).toEqual({ ip: '192.168.1.0' });
    expect(truncateIp('::ffff:10.1.2.3')).toEqual({ ip: '10.1.2.0' });
    expect(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toEqual({ ipv6: '2001:db8:85a3::' });
    expect(truncateIp('2001:0db8::1')).toEqual({ ipv6: '2001:db8:0::' });
    expect(truncateIp('not-an-ip')).toEqual({});
    expect(truncateIp(null)).toEqual({});
  });

  it('tells phones, tablets and computers apart', () => {
    expect(deviceType('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(DEVICE.tablet);
    expect(deviceType('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe(DEVICE.phone);
    expect(deviceType('Mozilla/5.0 (Linux; Android 14; SM-X710)')).toBe(DEVICE.tablet);
    expect(deviceType('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(DEVICE.pc);
    expect(deviceType(null)).toBe(DEVICE.pc);
  });
});

const nativeAdm = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ver: '1.2',
    assets: [
      { id: 1, title: { text: 'Island ferries, booked in two minutes' } },
      { id: 2, data: { value: 'Daily boats from Panaji.' } },
    ],
    link: { url: 'https://book.ferries.example/islands' },
    ...over,
  });

describe('reading bids', () => {
  const request = buildBidRequest(offer({ slots: 2 }));
  const response = (bids: object[], over: object = {}) => ({
    id: request.id,
    cur: 'INR',
    seatbid: [{ seat: 'dsp-1', bid: bids }],
    ...over,
  });
  const bid = (over: object = {}) => ({
    impid: '1',
    price: 30,
    adm: nativeAdm(),
    adomain: ['ferries.example'],
    crid: 'c1',
    ...over,
  });

  it('keeps a valid native text bid at or above the floor', () => {
    expect(parseBidResponse(request, response([bid()]))).toEqual([
      {
        impid: '1',
        price: 30,
        headline: 'Island ferries, booked in two minutes',
        body: 'Daily boats from Panaji.',
        url: 'https://book.ferries.example/islands',
        domain: 'ferries.example',
        creative: 'c1',
        seat: 'dsp-1',
      },
    ]);
  });

  it('drops everything else, bid by bid', () => {
    const bad = [
      bid({ impid: '9' }),
      bid({ price: 19 }),
      bid({ price: Number.NaN }),
      bid({ adomain: ['other.example'] }),
      bid({ adomain: ['a.example', 'b.example'] }),
      bid({ adm: '<script>alert(1)</script>' }),
      bid({ adm: nativeAdm({ link: { url: 'javascript:alert(1)' } }) }),
      bid({ adm: nativeAdm({ link: { url: 'http://book.ferries.example/' } }) }),
      bid({ adm: nativeAdm({ link: { url: 'https://user:pw@book.ferries.example/' } }) }),
      bid({
        adm: nativeAdm({
          assets: [
            { id: 1, title: { text: '<b>bold</b>' } },
            { id: 2, data: { value: 'x' } },
          ],
        }),
      }),
      bid({
        adm: nativeAdm({
          assets: [
            { id: 1, title: { text: 'x'.repeat(91) } },
            { id: 2, data: { value: 'x' } },
          ],
        }),
      }),
    ];
    for (const b of bad) expect(parseBidResponse(request, response([b])), JSON.stringify(b)).toEqual([]);
    expect(parseBidResponse(request, response([bid()], { id: 'other' }))).toEqual([]);
    expect(parseBidResponse(request, response([bid()], { cur: 'USD' }))).toEqual([]);
    expect(parseBidResponse(request, null)).toEqual([]);
    // A subdomain of the declared domain is fine.
    expect(parseBidResponse(request, response([bid({ adomain: ['example'] })]))).toHaveLength(0);
  });
});

describe('asking partners', () => {
  const request = buildBidRequest(offer());
  const ok = (body: object): ReturnType<Fetcher> =>
    Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) });
  const answer = {
    id: request.id,
    seatbid: [{ seat: 's', bid: [{ impid: '1', price: 25, adm: nativeAdm(), adomain: ['ferries.example'] }] }],
  };

  it('collects bids from those that answer, and stops waiting at tmax', async () => {
    const slow: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const fetcher: Fetcher = (url, init) => (url.includes('slow') ? slow(url, init) : ok(answer));
    const exchange = createExchange(fetcher);
    const started = performance.now();
    const bids = await exchange.ask(
      [
        { id: 'fast', endpoint: 'https://fast.example/bid' },
        { id: 'slow', endpoint: 'https://slow.example/bid' },
      ],
      request,
    );
    expect(performance.now() - started).toBeLessThan(TMAX_MS + 200);
    expect(bids.map(b => b.partner)).toEqual(['fast']);
    expect(exchange.state().inFlight).toBe(0);
  });

  it('skips a partner after repeated failures, for a while', async () => {
    let calls = 0;
    let t = 0;
    const exchange = createExchange(
      () => {
        calls += 1;
        return Promise.resolve({ status: 500, headers: { get: () => null }, text: () => Promise.resolve('') });
      },
      () => t,
    );
    const p = [{ id: 'broken', endpoint: 'https://broken.example/bid' }];
    for (let i = 0; i < BREAKER_FAILURES; i++) await exchange.ask(p, request);
    expect(exchange.state().open).toEqual(['broken']);
    await exchange.ask(p, request);
    expect(calls).toBe(BREAKER_FAILURES);
    t = BREAKER_COOLDOWN_MS + 1;
    await exchange.ask(p, request);
    expect(calls).toBe(BREAKER_FAILURES + 1);
  });

  it('asks at most MAX_IN_FLIGHT partners at once, and treats 204 and oversized answers properly', async () => {
    let calls = 0;
    const many = Array.from({ length: MAX_IN_FLIGHT + 10 }, (_, i) => ({
      id: `p${String(i)}`,
      endpoint: `https://p${String(i)}.example/`,
    }));
    const exchange = createExchange(() => {
      calls += 1;
      return Promise.resolve({ status: 204, headers: { get: () => null }, text: () => Promise.resolve('') });
    });
    expect(await exchange.ask(many, request)).toEqual([]);
    expect(calls).toBe(MAX_IN_FLIGHT);
    const big = createExchange(() =>
      Promise.resolve({ status: 200, headers: { get: () => '999999' }, text: () => Promise.resolve('{}') }),
    );
    expect(await big.ask([{ id: 'b', endpoint: 'https://b.example/' }], request)).toEqual([]);
    const huge = createExchange(() =>
      Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve('x'.repeat(70_000)) }),
    );
    expect(await huge.ask([{ id: 'h', endpoint: 'https://h.example/' }], request)).toEqual([]);
    expect(huge.state().open).toEqual([]);
  });
});
