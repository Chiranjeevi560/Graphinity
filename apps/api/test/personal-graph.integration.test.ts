import { beforeAll, describe, expect, it } from 'vitest';
import { personalGraphQueueStatus, projectPersonalGraphSignals } from '../src/personal-data.ts';
import { startApp, type TestApp } from './helpers/app.ts';

let h: TestApp;
beforeAll(async () => {
  h = await startApp(() => Date.parse('2026-10-22T10:00:00Z'));
  return h.close;
});

async function createPerson(handle: string) {
  const person = await h.person();
  const profile = await h.call('POST', '/me/profile', person.token, {
    handle,
    country: 'IN',
    fields: ['imports-customs'],
    adult: true,
  });
  expect(profile.statusCode).toBe(201);
  return person;
}

describe('personal knowledge graph', () => {
  it('records first-party interactions only when the matching purpose is enabled', async () => {
    const optedIn = await createPerson('graph.optedin');
    await h.call('PUT', '/me/consents', optedIn.token, {
      choices: [{ category: 'interaction_history', enabled: true }],
    });
    const asked = await h.call('POST', '/questions', optedIn.token, {
      title: 'How do I compare customs forms?',
      field: 'imports-customs',
      country: 'IN',
    });
    expect(asked.statusCode).toBe(201);
    const questionId = asked.json<{ question: { id: string } }>().question.id;
    const stored = await h.call('GET', '/me/graph', optedIn.token);
    const signals = stored.json<{
      graph: { signals: Array<{ id: string; signalType: string; subjectId: string; source: string; value: object }> };
    }>().graph.signals;
    expect(signals).toContainEqual(
      expect.objectContaining({
        signalType: 'question_asked',
        subjectId: questionId,
        source: 'graphinity_generated',
        value: {},
      }),
    );
    const recorded = signals.find(signal => signal.signalType === 'question_asked');
    expect(recorded).toBeDefined();
    expect((await h.call('DELETE', `/me/graph/signals/${recorded?.id}`, optedIn.token)).statusCode).toBe(204);
    expect(
      (await h.call('GET', '/me/graph', optedIn.token)).json<{ graph: { signals: unknown[] } }>().graph.signals,
    ).toEqual([]);

    const optedOut = await createPerson('graph.optedout');
    const untracked = await h.call('POST', '/questions', optedOut.token, {
      title: 'How do I estimate parcel delivery time?',
      field: 'imports-customs',
      country: 'IN',
    });
    expect(untracked.statusCode).toBe(201);
    expect(
      (await h.call('GET', '/me/graph', optedOut.token)).json<{ graph: { signals: unknown[] } }>().graph.signals,
    ).toEqual([]);
  });

  it('projects opted-in interaction events as temporal evidence edges and is retry-safe', async () => {
    const person = await createPerson('graph.projection');
    await h.call('PUT', '/me/consents', person.token, {
      choices: [{ category: 'interaction_history', enabled: true }],
    });
    const asked = await h.call('POST', '/questions', person.token, {
      title: 'Private wording is not copied into graph labels',
      field: 'imports-customs',
      country: 'IN',
    });
    expect(asked.statusCode).toBe(201);
    const before = await h.call('GET', '/me/graph', person.token);
    expect(before.json<{ graph: { edges: unknown[] } }>().graph.edges).toEqual([]);
    expect(await personalGraphQueueStatus(h.t.database)).toMatchObject({ pending: 1 });

    expect(await projectPersonalGraphSignals(h.t.database)).toBe(1);
    expect(await projectPersonalGraphSignals(h.t.database)).toBe(0);
    expect(await personalGraphQueueStatus(h.t.database)).toMatchObject({ pending: 0, oldestSeconds: 0 });
    const projected = await h.call('GET', '/me/graph', person.token);
    const graph = projected.json<{
      graph: {
        nodes: Array<{ entityType: string; label: string; source: string }>;
        edges: Array<{ relation: string; weight: number; confidence: number; evidenceSignalId: string | number }>;
      };
    }>().graph;
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: 'topic', label: 'imports-customs', source: 'graphinity_generated' }),
      ]),
    );
    expect(graph.nodes.some(node => node.entityType === 'question' && /^question:\d+$/.test(node.label))).toBe(true);
    expect(graph.nodes.some(node => node.label.includes('Private wording'))).toBe(false);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ relation: 'question_asked', weight: 1, confidence: 1 });
    const signalId = String(graph.edges[0]?.evidenceSignalId);
    expect((await h.call('DELETE', `/me/graph/signals/${signalId}`, person.token)).statusCode).toBe(204);
    expect(
      (await h.call('GET', '/me/graph', person.token)).json<{ graph: { edges: unknown[] } }>().graph.edges,
    ).toEqual([]);
  });

  it('does not project a queued event after the owner revokes its consent', async () => {
    const person = await createPerson('graph.revokebefore');
    await h.call('PUT', '/me/consents', person.token, {
      choices: [{ category: 'interaction_history', enabled: true }],
    });
    const asked = await h.call('POST', '/questions', person.token, {
      title: 'Question created before revocation',
      field: 'imports-customs',
      country: 'IN',
    });
    expect(asked.statusCode).toBe(201);
    await h.call('PUT', '/me/consents', person.token, {
      choices: [{ category: 'interaction_history', enabled: false }],
    });
    expect(await projectPersonalGraphSignals(h.t.database)).toBe(1);
    expect(
      (await h.call('GET', '/me/graph', person.token)).json<{ graph: { edges: unknown[] } }>().graph.edges,
    ).toEqual([]);
  });

  it('acknowledges malformed numeric event ids without poisoning the worker batch', async () => {
    const person = await createPerson('graph.poisonedid');
    await h.call('PUT', '/me/consents', person.token, {
      choices: [{ category: 'interaction_history', enabled: true }],
    });
    await h.t.owner.query(
      `INSERT INTO app.personal_signal_events
         (user_id, consent_category, signal_type, subject_id, source, expires_at)
       VALUES ($1, 'interaction_history', 'question_asked', $2, 'user_action', now() + interval '1 day')`,
      [person.id, '99999999999999999999'],
    );
    await expect(
      h.t.database.withUser(person.id, q => q.query('SELECT app.project_personal_graph_events(10)')),
    ).rejects.toThrow(/system transaction required/);
    await expect(
      h.t.database.withUser(person.id, q => q.query('SELECT * FROM app.personal_graph_projection_status()')),
    ).rejects.toThrow(/system transaction required/);
    expect(await projectPersonalGraphSignals(h.t.database)).toBe(1);
    const projected = await h.t.owner.query<{ projected_at: Date | null }>(
      'SELECT projected_at FROM app.personal_signal_events WHERE user_id = $1',
      [person.id],
    );
    expect(projected.rows[0]?.projected_at).not.toBeNull();
    expect(
      (await h.call('GET', '/me/graph', person.token)).json<{ graph: { edges: unknown[] } }>().graph.edges,
    ).toEqual([]);
  });

  it('builds insights only from the owner graph and currently consented categories', async () => {
    const owner = await createPerson('graph.insights');
    const other = await createPerson('graph.other');
    await h.call('PUT', '/me/consents', owner.token, {
      choices: [{ category: 'learning_expertise', enabled: true }],
    });
    await h.call('PUT', '/me/consents', other.token, {
      choices: [{ category: 'learning_expertise', enabled: true }],
    });
    const createNode = async (token: string, label: string) => {
      const response = await h.call('POST', '/me/graph/nodes', token, {
        category: 'learning_expertise',
        entityType: 'topic',
        label,
      });
      return response.json<{ node: { id: string } }>().node.id;
    };
    const seed = await createNode(owner.token, 'customs');
    const neighbor = await createNode(owner.token, 'tariffs');
    const disconnected = await createNode(owner.token, 'ceramics');
    const foreign = await createNode(other.token, 'private topic');

    const edgeResponse = await h.call('POST', '/me/graph/edges', owner.token, {
      category: 'learning_expertise',
      sourceNode: seed,
      targetNode: neighbor,
      relation: 'related_topic',
      weight: 0.9,
      confidence: 0.8,
    });
    expect(edgeResponse.statusCode, edgeResponse.body).toBe(201);
    expect(
      (
        await h.call('POST', '/me/graph/edges', owner.token, {
          category: 'learning_expertise',
          sourceNode: seed,
          targetNode: foreign,
          relation: 'related_topic',
        })
      ).statusCode,
    ).toBe(404);

    const result = await h.call('POST', '/me/graph/insights', owner.token, { seedNodeIds: [seed] });
    expect(result.statusCode).toBe(200);
    const insights = result.json<{
      insights: {
        algorithmVersion: string;
        nodes: Array<{ id: string; pageRank: number; personalizedRank: number; community: string }>;
      };
    }>().insights;
    expect(insights.algorithmVersion).toBe('personal-graph-v1');
    expect(insights.nodes.some(node => node.id === seed || node.id === foreign)).toBe(false);
    expect(insights.nodes.find(node => node.id === neighbor)?.personalizedRank).toBeGreaterThan(
      insights.nodes.find(node => node.id === disconnected)?.personalizedRank ?? 0,
    );

    await h.call('PUT', '/me/consents', owner.token, {
      choices: [{ category: 'learning_expertise', enabled: false }],
    });
    expect((await h.call('POST', '/me/graph/insights', owner.token, { seedNodeIds: [seed] })).statusCode).toBe(404);
  });

  it('requires consent to add first-party graph data and lets the owner inspect and delete it', async () => {
    const person = await createPerson('graph.owner');
    expect(
      (
        await h.call('POST', '/me/graph/nodes', person.token, {
          category: 'ownership',
          entityType: 'purchase',
          label: 'Mismatched consent category',
        })
      ).statusCode,
    ).toBe(400);
    const input = {
      category: 'ownership',
      entityType: 'device',
      label: 'My espresso machine',
      attributes: { region: 'IN', purchaseYear: 2023 },
      source: 'user_entered',
    };
    expect((await h.call('POST', '/me/graph/nodes', person.token, input)).statusCode).toBe(403);
    expect(
      (
        await h.call('PUT', '/me/consents', person.token, {
          choices: [{ category: 'ownership', enabled: true }],
        })
      ).statusCode,
    ).toBe(200);
    const created = await h.call('POST', '/me/graph/nodes', person.token, input);
    expect(created.statusCode).toBe(201);
    const node = created.json<{ node: { id: string; label: string; category: string } }>().node;
    expect(node).toMatchObject({ label: 'My espresso machine', category: 'ownership' });
    expect(
      (await h.call('GET', '/me/graph', person.token)).json<{ graph: { nodes: unknown[] } }>().graph.nodes,
    ).toHaveLength(1);
    const exported = await h.call('GET', '/me/data-export', person.token);
    expect(exported.statusCode).toBe(200);
    expect(
      exported.json<{
        profile: { handle: string };
        personalKnowledgeGraph: { nodes: Array<{ id: string }> };
      }>(),
    ).toMatchObject({
      profile: { handle: 'graph.owner' },
      personalKnowledgeGraph: { nodes: [expect.objectContaining({ id: node.id })] },
    });

    await h.call('PUT', '/me/consents', person.token, {
      choices: [{ category: 'ownership', enabled: false }],
    });
    expect((await h.call('POST', '/me/graph/nodes', person.token, input)).statusCode).toBe(403);
    // Revocation prevents further writes/use while preserving access to inspect and erase stored data.
    expect(
      (await h.call('GET', '/me/graph', person.token)).json<{ graph: { nodes: unknown[] } }>().graph.nodes,
    ).toHaveLength(1);
    expect((await h.call('DELETE', `/me/graph/nodes/${node.id}`, person.token)).statusCode).toBe(204);
    expect(
      (await h.call('GET', '/me/graph', person.token)).json<{ graph: { nodes: unknown[] } }>().graph.nodes,
    ).toHaveLength(0);
  });

  it('keeps graph rows private between accounts and rejects oversized attributes', async () => {
    const owner = await createPerson('graph.private');
    const other = await createPerson('graph.viewer');
    await h.call('PUT', '/me/consents', owner.token, {
      choices: [{ category: 'learning_expertise', enabled: true }],
    });
    const inserted = await h.call('POST', '/me/graph/nodes', owner.token, {
      category: 'learning_expertise',
      entityType: 'skill',
      label: 'TypeScript',
    });
    expect(inserted.statusCode).toBe(201);
    expect((await h.call('GET', '/me/graph', other.token)).json<{ graph: { nodes: unknown[] } }>().graph.nodes).toEqual(
      [],
    );
    expect(
      (
        await h.call('POST', '/me/graph/nodes', owner.token, {
          category: 'learning_expertise',
          entityType: 'skill',
          label: 'Large payload',
          attributes: { content: 'x'.repeat(3000) },
        })
      ).statusCode,
    ).toBe(400);
    expect((await h.call('DELETE', '/me/graph', owner.token)).json()).toEqual({ deleted: 1 });
    expect((await h.call('GET', '/me/graph', owner.token)).json<{ graph: { nodes: unknown[] } }>().graph.nodes).toEqual(
      [],
    );
  });

  it('purges only expired personal signal rows through the narrow maintenance function', async () => {
    const person = await createPerson('graph.expiry');
    await h.t.owner.query(
      `INSERT INTO app.personal_signal_events
         (user_id, consent_category, signal_type, source, occurred_at, expires_at)
       VALUES
         ($1, 'interaction_history', 'old_event', 'user_action', now() - interval '2 days', now() - interval '1 day'),
         ($1, 'interaction_history', 'current_event', 'user_action', now(), now() + interval '1 day')`,
      [person.id],
    );
    const result = await h.t.api.query<{ deleted: string }>('SELECT app.purge_expired_personal_signals() AS deleted');
    expect(result.rows).toEqual([{ deleted: '1' }]);
    const remaining = await h.t.owner.query<{ signal_type: string }>(
      'SELECT signal_type FROM app.personal_signal_events WHERE user_id = $1 ORDER BY signal_type',
      [person.id],
    );
    expect(remaining.rows).toEqual([{ signal_type: 'current_event' }]);
  });
});
