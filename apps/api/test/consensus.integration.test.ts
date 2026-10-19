// Agreement among real answers on a question page (spec §11.4, §11.5).
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  const handle = `agree.${String(names)}`;
  expect((await h.call('POST', '/me/profile', p.token, { handle, country: 'IN', fields: ['imports-customs'], adult: true })).statusCode).toBe(201);
  return { ...p, handle };
}

interface PageAnswer { id: string; body: string; claim: { minor: number; currency: string } | null; minorityPinned: boolean; rank: number; author: { reputation: number; accepted: number; medal: string | null } }
interface Page { answers: PageAnswer[]; consensus: { confidence: number; clusters: Array<{ currency: string; lowMinor: number; highMinor: number; share: number; answers: number }> } | null; selection: { stars: number | null } | null }

async function questionWith(bodies: string[]) {
  const asker = await member();
  const q = must((await h.call('POST', '/questions', asker.token, { title: 'How much customs did you pay on a ₹3 lakh watch through Chennai?', field: 'imports-customs', country: 'IN' })).json<{ question: { id: string } }>().question.id);
  const ids: string[] = [];
  const authors: Array<{ token: string }> = [];
  for (const body of bodies) {
    const author = await member();
    authors.push(author);
    const res = await h.call('POST', `/questions/${q}/answers`, author.token, { body });
    expect(res.statusCode).toBe(201);
    ids.push(must(res.json<{ answer: { id: string } }>().answer.id));
  }
  const page = async (token?: string) => (await h.call('GET', `/questions/${q}`, token)).json<Page>();
  return { asker, q, ids, authors, page };
}

describe('agreement among the answers', () => {
  it('appears once 3 answers report an amount, grouped within 8%, with the odd one out pinned', async () => {
    const { ids, page } = await questionWith([
      'Paid ₹95,000 in duty at Chennai air cargo last month.',
      'The duty came to ₹94,000 on a ₹3,00,000 watch for me.',
      'I paid Rs 96500 total including the clearance fee.',
      'Paid ₹1,40,000 because the invoice value didn’t match my card statement.',
    ]);
    const p = await page();
    expect(must(p.consensus).clusters.map(c => [c.lowMinor / 100, c.highMinor / 100, c.answers])).toEqual([[94_000, 96_500, 3], [140_000, 140_000, 1]]);
    expect(must(p.consensus).confidence).toBeGreaterThan(0);
    expect(must(p.consensus).confidence).toBeLessThan(1);
    const outlier = must(p.answers.find(a => a.id === ids[3]));
    expect(outlier.minorityPinned).toBe(true);
    expect(outlier.claim).toEqual({ minor: 14_000_000, currency: 'INR' });
    expect(p.answers.filter(a => a.minorityPinned)).toHaveLength(1);
  });

  it('stays away with fewer than 3 amounts, and ignores answers without one', async () => {
    const { page } = await questionWith([
      'Paid ₹95,000 in duty.',
      'Cleared smoothly, just keep the invoice handy.',
      'Paid ₹97,000 in duty.',
    ]);
    const p = await page();
    expect(p.consensus).toBeNull();
    expect(p.answers.filter(a => a.claim === null)).toHaveLength(1);
  });

  it('leaves hidden answers out', async () => {
    const { ids, authors, page } = await questionWith(['Paid ₹95,000 in duty at Chennai.', 'Paid ₹96,000 in duty at Chennai.', 'Paid ₹2,00,000 in duty at Chennai.']);
    await h.t.owner.query("INSERT INTO app.decisions (answer_id, decision) VALUES ($1, 'remove')", [ids[2]]);
    expect((await page()).consensus).toBeNull();
    // Its author still sees it, marked hidden; it still doesn't count.
    const theirs = await page(must(authors[2]).token);
    expect(theirs.answers).toHaveLength(3);
    expect(theirs.consensus).toBeNull();
  });
});

describe('the order of answers (spec §11.5)', () => {
  it('puts the picked answer first, then concrete answers in the agreeing group', async () => {
    const { asker, q, ids, page } = await questionWith([
      'Just be careful and it should be fine for you.',
      'Paid ₹95,000 at the Chennai airport counter in March, took 3 days.',
      'Paid ₹96,000 at the Chennai airport counter in April, took 2 days.',
      'Paid ₹94,500 in duty at the counter.',
    ]);
    const before = (await page()).answers.map(a => a.id);
    expect(before.indexOf(must(ids[0]))).toBe(before.length - 1);
    await h.call('PUT', `/questions/${q}/selection`, asker.token, { answerId: ids[3] });
    const after = await page();
    expect(after.answers[0]?.id).toBe(ids[3]);
    expect(after.answers.map(a => a.rank)).toEqual([...after.answers.map(a => a.rank)].sort((x, y) => y - x));
    await h.call('PUT', `/answers/${must(ids[3])}/rating`, asker.token, { stars: 5 });
    expect((await page()).selection?.stars).toBe(5);
  });

  it('shows each author’s standing in this field, and nobody’s id', async () => {
    const { page } = await questionWith(['Paid ₹95,000 in duty.']);
    const p = await page();
    expect(p.answers[0]?.author).toEqual({ reputation: 0, accepted: 0, medal: null });
    expect(JSON.stringify(p)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
