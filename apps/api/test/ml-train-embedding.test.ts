// The training run itself, as the worker thread runs it, on the main thread
// (the logic is a pure function of its input).
import { describe, expect, it } from 'vitest';
import { isHeldOut } from '../src/ml/embedding-gate.ts';
import { serializeModel, trainTextEmbedding } from '../src/ml/text-embedding.ts';
import { trainAndEvaluate, type WorkerInput } from '../src/ml/train-embedding.ts';

function questions(n: number): WorkerInput['questions'] {
  const goods = ['watch', 'camera', 'laptop', 'phone', 'perfume', 'bicycle', 'tablet', 'drone'];
  const places = ['dubai', 'chennai', 'delhi', 'singapore', 'mumbai', 'london', 'tokyo', 'paris'];
  return Array.from({ length: n }, (_, i) => {
    const g = goods[i % goods.length] ?? 'watch';
    const p = places[Math.floor(i / goods.length) % places.length] ?? 'dubai';
    return {
      id: String(i + 1),
      title: `customs duty on a ${g} at ${p}`,
      body: `what import tax did you pay when your ${g} arrived at ${p} airport by courier`,
    };
  });
}

describe('one training run', () => {
  const qs = questions(64);
  const heldOut = qs.filter(q => isHeldOut(q.id));

  it('never trains on a held-out question or its answers, and scores against words when nothing serves', () => {
    const answers = qs.map(q => ({ questionId: q.id, body: `I paid duty on mine ${q.id}` }));
    const result = trainAndEvaluate({ questions: qs, answers, serving: null, options: { dims: 8 } });
    expect(heldOut.length).toBeGreaterThan(0);
    expect(result.dataset.heldOutQuestions).toBe(heldOut.length);
    // Training documents: every other question once, and every other question's answer once.
    expect(result.dataset.trainingDocuments).toBe(2 * (qs.length - heldOut.length));
    expect(result.baseline).toMatchObject({ kind: 'bm25', version: null });
    expect(result.params.dims).toBe(8);
    expect(result.metrics.trainMs).toBeGreaterThanOrEqual(0);
  });

  it('scores against the serving model, fused with words, when one serves', () => {
    const serving = new Uint8Array(
      serializeModel(
        trainTextEmbedding(
          qs.map(q => q.title),
          { dims: 8 },
        ),
      ),
    );
    const result = trainAndEvaluate({ questions: qs, answers: [], serving: { version: 3, artifact: serving } });
    expect(result.baseline).toMatchObject({ kind: 'model', version: 3 });
  });

  it('keeps weights only for a version that is promoted', () => {
    const result = trainAndEvaluate({ questions: qs, answers: [], serving: null, options: { dims: 8 } });
    // Too few held-out queries to decide: not promoted, so no weights.
    expect(result.decision.promote).toBe(false);
    expect(result.decision.reason).toMatch(/evaluable/);
    expect(result.artifact).toBeNull();
  });
});

describe('learning what words alone cannot', () => {
  it('learns paraphrases from co-occurrence, beats word matching on held-out questions, and is promoted', () => {
    // Each product and place has two names. A question's title uses one, its details the other,
    // and the topic word differs too ("duty" vs "levy"): a held-out question's details share no
    // word with its title, so word matching can't find it. Both names do appear together in
    // other questions (title and details are trained as one document), which is all a model
    // has to learn from.
    const qs: WorkerInput['questions'] = [];
    for (let i = 0; i < 400; i++) {
      const item = i % 40;
      const place = Math.floor(i / 40) % 10;
      const topic = i % 3;
      const [title, detail] = [
        ['duty', 'levy'],
        ['visa', 'permit'],
        ['rent', 'lease'],
      ][topic] ?? ['duty', 'levy'];
      qs.push({
        id: String(i + 1),
        title: `${title} for prod${String(item)}a in town${String(place)}a`,
        body: `${detail} paid on prod${String(item)}b when it reached town${String(place)}b last month`,
      });
    }
    const result = trainAndEvaluate({ questions: qs, answers: [], serving: null, options: { dims: 32 } });
    expect(result.metrics.queries).toBeGreaterThanOrEqual(30);
    expect(result.baseline.kind).toBe('bm25');
    expect(result.metrics.mrr).toBeGreaterThan(result.baseline.mrr);
    expect(result.decision.promote).toBe(true);
    expect(result.decision.difference?.low).toBeGreaterThan(0);
    expect(result.artifact?.length).toBeGreaterThan(0);
  });
});
