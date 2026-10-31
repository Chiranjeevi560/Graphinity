import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decayTransitions, emptyTransitions, nextItems, observeSession } from '../src/kg/session-graph.ts';
import { attention, buildGraph, cosineAt, embed, initSage, linkAuc } from '../src/kg/graphsage.ts';
import { capacityAt, Dinic, trustInto } from '../src/kg/trust-flow.ts';
import { distillStudent, extractClaims, studentScore } from '../src/intelligence/claims.ts';
import { entailment, verifyFaithfulness } from '../src/intelligence/faithfulness.ts';
import { checkPlan, PlanError, runPlan, type Tool } from '../src/intelligence/orchestrator.ts';
import { runGolden, TemplateRegistry, templateOf } from '../src/intelligence/templates.ts';
import { retention, sweepEpisodes, validPreference } from '../src/intelligence/memory.ts';
import {
  dHash,
  hamming,
  HashIndex,
  isDuplicate,
  pHash,
  stripExif,
  verifyReceiptText,
  type Gray,
} from '../src/intelligence/media.ts';
import { appendEntry, canonical, verifyChain, type AuditEntry } from '../src/governance/audit-chain.ts';
import { decideRing } from '../src/governance/rollback.ts';
import { grievanceDeadlines, RESOLVE_MS, URGENT_MS, validStatement } from '../src/governance/legal.ts';

describe('session graph', () => {
  it('predicts by second order where it has seen enough, else first', () => {
    const t = emptyTransitions();
    for (let i = 0; i < 10; i++) {
      observeSession(t, ['visa', 'flight', 'hotel']);
      observeSession(t, ['car', 'flight', 'insurance']);
    }
    expect(nextItems(t, 'flight', 'visa')[0]?.item).toBe('hotel');
    expect(nextItems(t, 'flight', 'car')[0]?.item).toBe('insurance');
    expect(nextItems(t, 'flight', null)[0]?.probability).toBeCloseTo(0.5, 9);
    expect(nextItems(t, 'nowhere', null)).toEqual([]);
    decayTransitions(t, 0.5);
    expect(t.first.get('flight')?.get('hotel')).toBe(5);
    decayTransitions(t, 0.0001);
    expect(t.first.size).toBe(0);
  });
});

describe('GraphSAGE', () => {
  it('recovers held-out links in two communities better than features alone', () => {
    let s = 7;
    const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const n = 80;
    const d = 16;
    const features = Float32Array.from({ length: n * d }, () => r() - 0.5);
    const edges = [];
    const held: Array<[number, number]> = [];
    const neg: Array<[number, number]> = [];
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const same = a % 2 === b % 2;
        if (same && r() < 0.3) {
          if (r() < 0.1) held.push([a, b]);
          else edges.push({ from: a, to: b, relation: 0, trust: 1, ageDays: 0 });
        } else if (!same && r() < 0.1) neg.push([a, b]);
      }
    const graph = buildGraph(n, features, d, edges);
    const model = initSage(d, 1, r);
    const h = embed(model, graph);
    const base = linkAuc(
      features.map(v => v),
      d,
      held,
      neg,
    );
    expect(base).toBeLessThan(0.55);
    expect(linkAuc(h, d, held, neg)).toBeGreaterThan(0.7);
    expect(cosineAt(h, 0, 0, d)).toBeCloseTo(1, 3);
    expect(Number.isFinite(h[0])).toBe(true);
  });
  it('weights an old or untrusted edge less', () => {
    expect(attention({ trust: 1, ageDays: 90 })).toBeCloseTo(0.5, 9);
    expect(attention({ trust: -1, ageDays: 0 })).toBe(0);
  });
});

describe('the trust network', () => {
  it('Dinic finds a known max flow', () => {
    const f = new Dinic(4);
    f.addEdge(0, 1, 3);
    f.addEdge(0, 2, 2);
    f.addEdge(1, 2, 5);
    f.addEdge(1, 3, 2);
    f.addEdge(2, 3, 3);
    expect(f.maxFlow(0, 3)).toBe(5);
    expect(() => {
      f.addEdge(9, 0, 1);
    }).toThrow(RangeError);
  });
  it('INVARIANT: a Sybil clique of any size gets no more trust than its one attack edge carries', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), sybils => {
        // Moderator 0 → honest 1 → compromised 2 → clique.
        const edges: Array<[number, number]> = [
          [0, 1],
          [1, 2],
        ];
        const first = 3;
        for (let i = 0; i < sybils; i++) {
          edges.push([2, first + i]);
          edges.push([first + i, first + ((i + 1) % sybils)]);
        }
        const targets = Array.from({ length: sybils }, (_, i) => first + i);
        expect(trustInto(first + sybils, edges, [0], targets)).toBeLessThanOrEqual(capacityAt(2));
      }),
      { numRuns: 40 },
    );
  });
});

describe('claims', () => {
  it('reads money, durations and outcomes as people write them', () => {
    const c = extractClaims(
      'I paid ₹1,20,000 in duty and it cleared. It took 3 weeks. My friend spent 2 lakh rupees but was rejected.',
    );
    expect(c.find(x => x.value === 120000)).toMatchObject({ currency: 'INR', outcome: 'success' });
    expect(c.find(x => x.metric === 'duration')).toMatchObject({ days: 21 });
    expect(c.find(x => x.value === 200000)).toMatchObject({ outcome: 'failure' });
    expect(extractClaims('$50 was enough')[0]).toMatchObject({ value: 50, currency: 'USD', outcome: 'unknown' });
    expect(extractClaims('No numbers here at all.')).toEqual([]);
  });
  it('the student learns the teacher, and agrees with it on new sentences', () => {
    const train = [
      ...Array.from(
        { length: 80 },
        (_, i) => `I paid ₹${String(i + 100)} for the visa fee and it took ${String(i + 1)} days.`,
      ),
      ...Array.from(
        { length: 80 },
        (_, i) =>
          `Remember to carry your documents to office number ${String.fromCharCode(97 + (i % 26))} and ask politely.`,
      ),
    ];
    const m = distillStudent(train);
    expect(studentScore(m, 'I paid ₹999 and it took 12 days.')).toBeGreaterThan(
      studentScore(m, 'Carry your documents and ask politely.'),
    );
    const started = performance.now();
    for (let i = 0; i < 1000; i++) studentScore(m, 'I paid ₹999 and it took 12 days.');
    expect((performance.now() - started) / 1000).toBeLessThan(1);
  });
});

describe('faithfulness', () => {
  const sources = [{ id: 'a1', text: 'The customs duty was 38 percent. The officer did not ask for the receipt.' }];
  it('keeps what a person said and strips what they did not', () => {
    const v = verifyFaithfulness(
      'The customs duty was 38 percent. Duty was 50 percent. The officer asked for the receipt. Airlines refund everything.',
      sources,
    );
    expect(v.kept.map(k => k.source)).toEqual(['a1']);
    expect(v.dropped).toHaveLength(3);
  });
  it('a changed number or a dropped negation scores zero', () => {
    expect(entailment('duty was 38 percent', 'duty was 39 percent')).toBe(0);
    expect(entailment('it did not work', 'it did work')).toBe(0);
    expect(entailment('anything', 'the of')).toBe(0);
    expect(entailment('38', '38')).toBe(1);
  });
});

describe('the tool plan', () => {
  const tool = (name: string, run: Tool<null>['run'], timeoutMs = 200): [string, Tool<null>] => [
    name,
    { name, readOnly: true, timeoutMs, run },
  ];
  const tools = new Map([
    tool('one', () => Promise.resolve(1)),
    tool('plus', i => Promise.resolve(Number(i.n) + 1)),
    tool('boom', () => Promise.reject(new Error('secret detail'))),
    tool(
      'hang',
      (_i, _c, signal) =>
        new Promise((_r, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('timeout'));
          });
        }),
      20,
    ),
  ]);
  it('runs in dependency order, passing results along', async () => {
    const r = await runPlan(
      [
        { id: 'b', tool: 'plus', input: { n: { $from: 'a' } }, after: ['a'] },
        { id: 'a', tool: 'one', input: {} },
      ],
      tools,
      null,
    );
    expect(r.get('b')).toMatchObject({ ok: true, value: 2 });
  });
  it('refuses cycles, unknown tools and dependencies, duplicates and huge plans before running', () => {
    const bad = (plan: Parameters<typeof checkPlan>[0]) => () => {
      checkPlan(plan, tools);
    };
    expect(
      bad([
        { id: 'a', tool: 'one', input: {}, after: ['b'] },
        { id: 'b', tool: 'one', input: {}, after: ['a'] },
      ]),
    ).toThrow(PlanError);
    expect(bad([{ id: 'a', tool: 'nope', input: {} }])).toThrow(PlanError);
    expect(bad([{ id: 'a', tool: 'one', input: {}, after: ['z'] }])).toThrow(PlanError);
    expect(
      bad([
        { id: 'a', tool: 'one', input: {} },
        { id: 'a', tool: 'one', input: {} },
      ]),
    ).toThrow(PlanError);
    expect(bad(Array.from({ length: 33 }, (_, i) => ({ id: String(i), tool: 'one', input: {} })))).toThrow(PlanError);
  });
  it('contains failures and timeouts, naming no detail', async () => {
    const r = await runPlan(
      [
        { id: 'x', tool: 'boom', input: {} },
        { id: 'y', tool: 'plus', input: { n: 1 }, after: ['x'] },
        { id: 'h', tool: 'hang', input: {} },
      ],
      tools,
      null,
    );
    expect(r.get('x')).toMatchObject({ ok: false, error: 'failed' });
    expect(r.get('y')).toMatchObject({ ok: false, error: 'dependency failed' });
    expect(r.get('h')).toMatchObject({ ok: false, error: 'timeout' });
    const none = await runPlan([{ id: 'a', tool: 'one', input: {} }], tools, null, 0);
    expect(none.get('a')).toMatchObject({ ok: false, error: 'out of time' });
  });
});

describe('templates', () => {
  it('admit a version only if its golden set passes, and refuse a forged hash', () => {
    const reg = new TemplateRegistry();
    const t = templateOf('claims', 'extract money');
    const run = (s: string) => extractClaims(s).length;
    expect(reg.register(t, [{ input: 'paid $5', expected: 0 }], run).failures).toEqual([0]);
    expect(reg.latest('claims')).toBeNull();
    expect(reg.register(t, [], run).total).toBe(0);
    expect(reg.latest('claims')).toBeNull();
    reg.register(t, [{ input: 'paid $5', expected: 1 }], run);
    reg.register(t, [{ input: 'paid $5', expected: 1 }], run);
    expect(reg.latest('claims')?.hash).toBe(t.hash);
    expect(() => reg.register({ ...t, body: 'changed' }, [], run)).toThrow(/hash/);
    expect(runGolden([{ input: 1, expected: 1 }], x => x).passed).toBe(1);
  });
});

describe('memory', () => {
  it('fades, is reinforced by review, and consolidates', () => {
    const e = { key: 'visa', at: 0, strength: 1, reviews: 0 };
    expect(retention(e, 6 * 3_600_000)).toBeCloseTo(Math.exp(-1), 9);
    expect(retention({ ...e, reviews: 3 }, 6 * 3_600_000)).toBeGreaterThan(retention(e, 6 * 3_600_000));
    const s = sweepEpisodes([e, { ...e, key: 'kept', at: 1e9, reviews: 3 }], 1e9);
    expect(s.forgotten).toBe(1);
    expect(s.consolidate).toEqual(['kept']);
    expect(s.keep.map(k => k.key)).toEqual(['kept']);
    expect(validPreference('currency', 'INR')).toBe(true);
    expect(validPreference('currency', 'XXX')).toBe(false);
    expect(validPreference('nope', 'x')).toBe(false);
  });
});

describe('images and receipts', () => {
  const picture = (w: number, h: number, shift = 0): Gray => {
    const pixels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const v = y / h;
        pixels[y * w + x] = Math.min(255, shift + 127 + 100 * Math.sin(u * 9 + v * 3) * Math.cos(v * 7));
      }
    return { width: w, height: h, pixels };
  };
  const other: Gray = (() => {
    const p = new Uint8Array(128 * 128);
    for (let i = 0; i < p.length; i++) p[i] = (i * 2654435761) >>> 24;
    return { width: 128, height: 128, pixels: p };
  })();
  it('match the same picture resized or brightened, and not a different one', () => {
    for (const hash of [dHash, pHash]) {
      const a = hash(picture(256, 256));
      expect(isDuplicate(a, hash(picture(97, 97)))).toBe(true);
      expect(isDuplicate(a, hash(picture(256, 256, 20)))).toBe(true);
      expect(isDuplicate(a, hash(other))).toBe(false);
    }
    expect(hamming(0n, 0b1011n)).toBe(3);
  });
  it('the index finds what a linear scan would', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { minLength: 1, maxLength: 40 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        (hashes, query) => {
          const index = new HashIndex();
          for (const h of hashes) index.add(h);
          const linear = hashes.some(h => isDuplicate(h, query));
          expect(index.find(query) !== null).toBe(linear);
          expect(index.find(hashes[0] ?? 0n)).not.toBeNull();
        },
      ),
    );
  });
  it('a receipt yields signals and keeps no identifier', () => {
    const text =
      'Passenger: Asha Rao\nEmail asha@example.com\nPAN ABCDE1234F\nPhone +91 9876543210\nCard 4111 1111 1111 1111\nDate 2026-03-14\nHSN Code: 91021100\nTotal duty: Rs. 12,450.50';
    const r = verifyReceiptText(text);
    expect(r).toMatchObject({ date: '2026-03-14', tariffCode: '91021100', dutyTotal: 12450.5 });
    for (const secret of ['Asha', 'asha@', 'ABCDE', '9876543210', '4111']) expect(r.redacted).not.toContain(secret);
    expect(verifyReceiptText('nothing useful')).toMatchObject({ date: null, tariffCode: null, dutyTotal: null });
  });
  it('removes EXIF from a JPEG and leaves the rest', () => {
    const app1 = Buffer.from([0xff, 0xe1, 0x00, 0x06, 0x47, 0x50, 0x53, 0x21]);
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x01, 0x02]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0xaa, 0xbb]);
    const out = stripExif(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app0, sos]));
    expect(out.includes(Buffer.from('GPS!'))).toBe(false);
    expect(out.equals(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sos]))).toBe(true);
    const png = Buffer.from([0x89, 0x50]);
    expect(stripExif(png)).toBe(png);
  });
});

describe('the audit chain', () => {
  const chain = () => {
    const list: AuditEntry[] = [];
    for (let i = 0; i < 5; i++)
      list.push(
        appendEntry(list.at(-1) ?? null, {
          action: 'a',
          actor: 'm',
          subject: String(i),
          detail: { n: i, z: [1, { b: 2, a: 1 }] },
          at: '2026-10-31T00:00:00Z',
        }),
      );
    return list;
  };
  it('holds until anything changes, and names where it broke', () => {
    const c = chain();
    expect(verifyChain(c)).toBeNull();
    const edited = chain();
    (edited[2] as AuditEntry).subject = 'x';
    expect(verifyChain(edited)).toBe(3);
    expect(verifyChain(chain().filter((_, i) => i !== 1))).toBe(3);
    const relinked = chain();
    (relinked[3] as AuditEntry).prevHash = 'f'.repeat(64);
    expect(verifyChain(relinked)).toBe(4);
    expect(canonical({ b: 1, a: [null] })).toBe('{"a":[null],"b":1}');
    expect(canonical(undefined)).toBe('null');
  });
});

describe('the rollback governor', () => {
  const base = { errorRate: 0.001, p95Ms: 100 };
  it('advances when healthy, holds without evidence, rolls back on harm', () => {
    expect(decideRing(1, { requests: 1000, errors: 1, p95Ms: 100 }, base)).toBe('advance');
    expect(decideRing(1, { requests: 100, errors: 0, p95Ms: 100 }, base)).toBe('hold');
    expect(decideRing(1, { requests: 0, errors: 0, p95Ms: 0 }, base)).toBe('hold');
    expect(decideRing(1, { requests: 1000, errors: 50, p95Ms: 100 }, base)).toBe('rollback');
    expect(decideRing(1, { requests: 1000, errors: 0, p95Ms: 200 }, base)).toBe('rollback');
    expect(decideRing(3, { requests: 1000, errors: 0, p95Ms: 100 }, base)).toBe('hold');
  });
});

describe('legal clocks', () => {
  it('set the right deadlines, and refuse a hollow statement of reasons', () => {
    expect(grievanceDeadlines('general', 0).resolveBy).toBe(RESOLVE_MS);
    expect(grievanceDeadlines('unlawful_content', 0).resolveBy).toBe(URGENT_MS);
    const s = {
      restriction: 'removal' as const,
      facts: 'Posted a stranger’s phone number.',
      legalGround: null,
      termsGround: 'Rule 4',
      automated: false,
      redress: 'Appeal within six months.',
    };
    expect(validStatement(s)).toBe(true);
    expect(validStatement({ ...s, termsGround: null })).toBe(false);
    expect(validStatement({ ...s, facts: 'no' })).toBe(false);
  });
});
