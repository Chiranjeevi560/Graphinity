import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { analyzePersonalGraph } from '../personal-graph-algorithms.ts';
import { fail, signedIn } from './common.ts';

export interface PersonalGraphDeps {
  db: Database;
}

const entityTypes = [
  'expertise',
  'skill',
  'certification',
  'interest',
  'topic',
  'saved_question',
  'search_term',
  'ownership',
  'product',
  'device',
  'book',
  'vehicle',
  'course',
  'software',
  'tool',
  'purchase',
  'wishlist',
  'retailer_preference',
  'brand_preference',
  'budget_preference',
  'currency_preference',
  'payment_preference',
  'shipping_preference',
  'warranty_preference',
  'import_preference',
  'country_lived',
  'country_travelled',
  'industry',
  'company',
  'education',
  'language',
  'learning_goal',
  'learning_progress',
  'notification_preference',
  'interaction',
  'trust_evidence',
  'relationship',
  'privacy_preference',
] as const;

const entityCategories: Record<(typeof entityTypes)[number], readonly string[]> = {
  expertise: ['learning_expertise'],
  skill: ['learning_expertise'],
  certification: ['learning_expertise'],
  interest: ['learning_expertise'],
  topic: ['learning_expertise'],
  saved_question: ['interaction_history', 'reading_history'],
  search_term: ['search_history'],
  ownership: ['ownership'],
  product: ['ownership', 'purchase_history', 'commercial_personalization'],
  device: ['ownership'],
  book: ['ownership'],
  vehicle: ['ownership'],
  course: ['learning_expertise'],
  software: ['ownership'],
  tool: ['ownership'],
  purchase: ['purchase_history'],
  wishlist: ['ownership', 'commercial_personalization'],
  retailer_preference: ['commercial_personalization'],
  brand_preference: ['commercial_personalization'],
  budget_preference: ['commercial_personalization'],
  currency_preference: ['commercial_personalization'],
  payment_preference: ['commercial_personalization'],
  shipping_preference: ['commercial_personalization'],
  warranty_preference: ['commercial_personalization'],
  import_preference: ['commercial_personalization'],
  country_lived: ['travel_preferences'],
  country_travelled: ['travel_preferences'],
  industry: ['learning_expertise'],
  company: ['learning_expertise'],
  education: ['learning_expertise'],
  language: ['learning_expertise'],
  learning_goal: ['learning_expertise'],
  learning_progress: ['learning_expertise'],
  notification_preference: ['notification_preferences'],
  interaction: ['interaction_history'],
  trust_evidence: ['interaction_history'],
  relationship: ['relationship_graph'],
  privacy_preference: ['identity'],
};

const nodeBody = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'entityType', 'label'],
  properties: {
    category: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
    entityType: { type: 'string', enum: entityTypes },
    label: { type: 'string', minLength: 1, maxLength: 240 },
    attributes: { type: 'object', maxProperties: 30 },
    source: { type: 'string', enum: ['user_entered', 'user_imported'] },
  },
} as const;

const insightsBody = {
  type: 'object',
  additionalProperties: false,
  required: ['seedNodeIds'],
  properties: {
    seedNodeIds: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
} as const;

const edgeBody = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'sourceNode', 'targetNode', 'relation'],
  properties: {
    category: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
    sourceNode: { type: 'string', format: 'uuid' },
    targetNode: { type: 'string', format: 'uuid' },
    relation: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
    weight: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export function registerPersonalGraphRoutes(app: FastifyInstance, deps: PersonalGraphDeps) {
  app.post(
    '/me/graph/insights',
    { config: { auth: 'required' }, schema: { body: insightsBody } },
    async (req, reply) => {
      const user = signedIn(req);
      const body = req.body as { seedNodeIds: string[]; limit?: number };
      const result = await deps.db.withUser(user.id, async q => {
        const nodes = await q.query<{ id: string; entityType: string; category: string }>(
          `SELECT n.id, n.entity_type AS "entityType", n.consent_category AS category
           FROM app.personal_graph_nodes n
           WHERE n.user_id = $1 AND (
             EXISTS (SELECT 1 FROM app.consent_categories c WHERE c.name = n.consent_category AND c.required_for_service)
             OR EXISTS (SELECT 1 FROM app.user_consent_settings s
                        WHERE s.user_id = $1 AND s.category = n.consent_category AND s.enabled)
           )
           ORDER BY n.id LIMIT 1001`,
          [user.id],
        );
        if (nodes.rows.length > 1000) return { error: 'too_large' as const };
        const edges = await q.query<{ sourceNode: string; targetNode: string; weight: number }>(
          `SELECT e.source_node AS "sourceNode", e.target_node AS "targetNode", e.weight
           FROM app.personal_graph_edges e
           WHERE e.user_id = $1 AND (
             EXISTS (SELECT 1 FROM app.consent_categories c WHERE c.name = e.consent_category AND c.required_for_service)
             OR EXISTS (SELECT 1 FROM app.user_consent_settings s
                        WHERE s.user_id = $1 AND s.category = e.consent_category AND s.enabled)
           )
           ORDER BY e.id LIMIT 5001`,
          [user.id],
        );
        if (edges.rows.length > 5000) return { error: 'too_large' as const };
        if (body.seedNodeIds.some(id => !nodes.rows.some(node => node.id === id))) {
          return { error: 'seed_unavailable' as const };
        }
        return {
          insights: analyzePersonalGraph(nodes.rows, edges.rows, body.seedNodeIds, body.limit ?? 20),
        };
      });
      if ('error' in result) {
        if (result.error === 'too_large') {
          return fail(
            reply,
            422,
            'graph_too_large',
            'This graph exceeds the current analysis limit. Remove older graph items and try again.',
          );
        }
        return fail(
          reply,
          404,
          'graph_seed_unavailable',
          'One or more selected items are not available in your active graph.',
        );
      }
      return result;
    },
  );

  app.delete('/me/graph', { config: { auth: 'required', write: true } }, async req => {
    const user = signedIn(req);
    return deps.db.withUser(user.id, async q => {
      const signals = await q.query('DELETE FROM app.personal_signal_events WHERE user_id = $1', [user.id]);
      const collections = await q.query('DELETE FROM app.personal_collections WHERE user_id = $1', [user.id]);
      const nodes = await q.query('DELETE FROM app.personal_graph_nodes WHERE user_id = $1', [user.id]);
      return { deleted: (signals.rowCount ?? 0) + (collections.rowCount ?? 0) + (nodes.rowCount ?? 0) };
    });
  });

  app.get('/me/data-export', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    return deps.db.withUser(user.id, async q => {
      const profile = await q.query(
        `SELECT p.handle, p.country, p.adult_confirmed_at AS "adultConfirmedAt", p.created_at AS "createdAt",
                COALESCE((SELECT json_agg(json_build_object('slug', f.slug, 'name', f.name) ORDER BY f.position)
                          FROM app.profile_fields pf JOIN app.fields f ON f.slug = pf.field
                          WHERE pf.profile_id = p.id), '[]') AS fields
         FROM app.profiles p WHERE p.id = $1`,
        [user.id],
      );
      const questions = await q.query(
        `SELECT id, field, country, title, body, created_at AS "createdAt"
         FROM app.questions WHERE asker_id = $1 ORDER BY created_at`,
        [user.id],
      );
      const answers = await q.query(
        `SELECT id, question_id AS "questionId", body, created_at AS "createdAt"
         FROM app.answers WHERE answerer_id = $1 ORDER BY created_at`,
        [user.id],
      );
      const selections = await q.query(
        `SELECT s.question_id AS "questionId", s.answer_id AS "answerId", s.changes,
                s.last_change_reason AS "lastChangeReason", s.selected_at AS "selectedAt",
                v.correct AS "selectedAnswerWasCorrect", v.at AS "verdictAt"
         FROM app.selections s JOIN app.questions qn ON qn.id = s.question_id
         LEFT JOIN app.verdicts v ON v.answer_id = s.answer_id
         WHERE qn.asker_id = $1 ORDER BY s.selected_at`,
        [user.id],
      );
      const helpfulMarks = await q.query(
        `SELECT h.answer_id AS "answerId", h.marked_at AS "markedAt"
         FROM app.helpful_marks h JOIN app.answers a ON a.id = h.answer_id
         JOIN app.questions qn ON qn.id = a.question_id
         WHERE qn.asker_id = $1 ORDER BY h.marked_at`,
        [user.id],
      );
      const routes = await q.query(
        `SELECT question_id AS "questionId", wave, routed_at AS "routedAt", seen_at AS "seenAt",
                ranking_score AS "rankingScore", expertise_weight AS "expertiseWeight",
                circadian_fit AS "circadianFit", diversity_fit AS "diversityFit",
                ranking_version AS "rankingVersion"
         FROM app.routes WHERE profile_id = $1 ORDER BY routed_at`,
        [user.id],
      );
      const reports = await q.query(
        `SELECT question_id AS "questionId", answer_id AS "answerId", reason, note, created_at AS "createdAt"
         FROM app.reports WHERE reporter_id = $1 ORDER BY created_at`,
        [user.id],
      );
      const points = await q.query(
        `SELECT field, amount, reason, question_id AS "questionId", answer_id AS "answerId",
                created_at AS "createdAt"
         FROM app.points_ledger WHERE recipient_id = $1 OR giver_id = $1 ORDER BY created_at`,
        [user.id],
      );
      const networkActivity = await q.query(
        `SELECT day, count(*)::integer AS marks FROM app.network_marks
         WHERE profile_id = $1 GROUP BY day ORDER BY day`,
        [user.id],
      );
      const pushDevices = await q.query(
        `SELECT id, created_at AS "createdAt" FROM app.push_subscriptions
         WHERE profile_id = $1 ORDER BY created_at`,
        [user.id],
      );
      const consents = await q.query(
        `SELECT c.name, c.purpose, c.data_description AS "dataDescription", c.retention, c.recipients,
                COALESCE(s.enabled, c.required_for_service) AS enabled,
                s.policy_version AS "policyVersion", s.updated_at AS "updatedAt"
         FROM app.consent_categories c LEFT JOIN app.user_consent_settings s
           ON s.category = c.name AND s.user_id = $1 ORDER BY c.name`,
        [user.id],
      );
      const consentHistory = await q.query(
        `SELECT category, enabled, policy_version AS "policyVersion", source, changed_at AS "changedAt"
         FROM app.user_consent_audit_log WHERE user_id = $1 ORDER BY changed_at, id`,
        [user.id],
      );
      const nodes = await q.query(
        `SELECT id, consent_category AS category, entity_type AS "entityType", label, attributes, source,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM app.personal_graph_nodes WHERE user_id = $1 ORDER BY created_at`,
        [user.id],
      );
      const edges = await q.query(
        `SELECT id, consent_category AS category, source_node AS "sourceNode", target_node AS "targetNode",
                relation, weight, confidence, freshness, evidence_signal_id AS "evidenceSignalId",
                created_at AS "createdAt"
         FROM app.personal_graph_edges WHERE user_id = $1 ORDER BY created_at`,
        [user.id],
      );
      const signals = await q.query(
        `SELECT id, consent_category AS category, signal_type AS "signalType", subject_id AS "subjectId",
                value, source, occurred_at AS "occurredAt", expires_at AS "expiresAt"
         FROM app.personal_signal_events WHERE user_id = $1 ORDER BY occurred_at`,
        [user.id],
      );
      const collections = await q.query(
        `SELECT id, consent_category AS category, name, description, created_at AS "createdAt",
                updated_at AS "updatedAt"
         FROM app.personal_collections WHERE user_id = $1 ORDER BY created_at`,
        [user.id],
      );
      return {
        exportedAt: new Date().toISOString(),
        profile: profile.rows[0] ?? null,
        questions: questions.rows,
        answers: answers.rows,
        interactions: {
          selections: selections.rows,
          helpfulMarks: helpfulMarks.rows,
          routedQuestions: routes.rows,
          reports: reports.rows,
          points: points.rows,
          networkActivityByDay: networkActivity.rows,
          pushDevices: pushDevices.rows,
        },
        consents: consents.rows,
        consentHistory: consentHistory.rows,
        personalKnowledgeGraph: {
          nodes: nodes.rows,
          edges: edges.rows,
          signals: signals.rows,
          collections: collections.rows,
        },
      };
    });
  });

  app.get('/me/graph', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    return deps.db.withUser(user.id, async q => {
      const nodes = await q.query(
        `SELECT id, consent_category AS category, entity_type AS "entityType", label, attributes,
                source, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM app.personal_graph_nodes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000`,
        [user.id],
      );
      const edges = await q.query(
        `SELECT id, consent_category AS category, source_node AS "sourceNode", target_node AS "targetNode",
                relation, weight, confidence, freshness, evidence_signal_id AS "evidenceSignalId",
                created_at AS "createdAt"
         FROM app.personal_graph_edges WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10000`,
        [user.id],
      );
      const signals = await q.query(
        `SELECT id, consent_category AS category, signal_type AS "signalType", subject_id AS "subjectId",
                value, source, occurred_at AS "occurredAt", expires_at AS "expiresAt"
         FROM app.personal_signal_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 10000`,
        [user.id],
      );
      const collections = await q.query(
        `SELECT id, consent_category AS category, name, description,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM app.personal_collections WHERE user_id = $1 ORDER BY created_at`,
        [user.id],
      );
      return {
        graph: {
          nodes: nodes.rows,
          edges: edges.rows,
          signals: signals.rows,
          collections: collections.rows,
        },
      };
    });
  });

  app.post(
    '/me/graph/nodes',
    { config: { auth: 'required', write: true }, schema: { body: nodeBody } },
    async (req, reply) => {
      const user = signedIn(req);
      const body = req.body as {
        category: string;
        entityType: (typeof entityTypes)[number];
        label: string;
        attributes?: Record<string, unknown>;
        source?: 'user_entered' | 'user_imported';
      };
      if (Buffer.byteLength(JSON.stringify(body.attributes ?? {}), 'utf8') > 2048) {
        return fail(reply, 400, 'attributes_too_large', 'Shorten the extra details and try again.');
      }
      if (!entityCategories[body.entityType].includes(body.category)) {
        return fail(reply, 400, 'graph_category_mismatch', 'Choose the data use that matches this kind of graph item.');
      }
      const result = await deps.db.withUser(user.id, async q => {
        const consent = await q.query<{ allowed: boolean }>(
          `SELECT c.required_for_service OR COALESCE(s.enabled, false) AS allowed
           FROM app.consent_categories c LEFT JOIN app.user_consent_settings s
             ON s.user_id = $1 AND s.category = c.name
           WHERE c.name = $2`,
          [user.id, body.category],
        );
        if (!consent.rows[0]) return { error: 'category' as const };
        if (!consent.rows[0].allowed) return { error: 'consent' as const };
        const { rows } = await q.query(
          `INSERT INTO app.personal_graph_nodes (user_id, consent_category, entity_type, label, attributes, source)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING id, consent_category AS category, entity_type AS "entityType", label, attributes,
                     source, created_at AS "createdAt"`,
          [
            user.id,
            body.category,
            body.entityType,
            body.label.trim(),
            JSON.stringify(body.attributes ?? {}),
            body.source ?? 'user_entered',
          ],
        );
        return { node: rows[0] };
      });
      if ('error' in result) {
        if (result.error === 'consent')
          return fail(reply, 403, 'consent_required', 'Allow this data use in your privacy settings first.');
        return fail(reply, 400, 'unknown_consent_category', 'That data use is not available.');
      }
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/me/graph/edges',
    { config: { auth: 'required', write: true }, schema: { body: edgeBody } },
    async (req, reply) => {
      const user = signedIn(req);
      const body = req.body as {
        category: string;
        sourceNode: string;
        targetNode: string;
        relation: string;
        weight?: number;
        confidence?: number;
      };
      if (body.sourceNode === body.targetNode) {
        return fail(reply, 400, 'invalid_graph_edge', 'Choose two different graph items.');
      }
      const result = await deps.db.withUser(user.id, async q => {
        const consent = await q.query<{ allowed: boolean }>(
          `SELECT c.required_for_service OR COALESCE(s.enabled, false) AS allowed
           FROM app.consent_categories c LEFT JOIN app.user_consent_settings s
             ON s.user_id = $1 AND s.category = c.name
           WHERE c.name = $2`,
          [user.id, body.category],
        );
        if (!consent.rows[0]) return { error: 'category' as const };
        if (!consent.rows[0].allowed) return { error: 'consent' as const };
        const endpoints = await q.query<{ id: string }>(
          `SELECT n.id FROM app.personal_graph_nodes n
           WHERE n.user_id = $1 AND n.id = ANY($2::uuid[])
             AND (EXISTS (SELECT 1 FROM app.consent_categories c WHERE c.name = n.consent_category AND c.required_for_service)
                  OR EXISTS (SELECT 1 FROM app.user_consent_settings s
                             WHERE s.user_id = $1 AND s.category = n.consent_category AND s.enabled))`,
          [user.id, [body.sourceNode, body.targetNode]],
        );
        if (endpoints.rows.length !== 2) return { error: 'endpoint' as const };
        const { rows } = await q.query(
          `INSERT INTO app.personal_graph_edges
             (user_id, consent_category, source_node, target_node, relation, weight, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, consent_category AS category, source_node AS "sourceNode",
                     target_node AS "targetNode", relation, weight, confidence,
                     freshness, evidence_signal_id AS "evidenceSignalId", created_at AS "createdAt"`,
          [
            user.id,
            body.category,
            body.sourceNode,
            body.targetNode,
            body.relation,
            body.weight ?? 1,
            body.confidence ?? 1,
          ],
        );
        return { edge: rows[0] };
      });
      if ('error' in result) {
        if (result.error === 'consent') {
          return fail(reply, 403, 'consent_required', 'Allow this data use in your privacy settings first.');
        }
        if (result.error === 'endpoint') {
          return fail(
            reply,
            404,
            'graph_node_unavailable',
            'One or more graph items are not available in your active graph.',
          );
        }
        return fail(reply, 400, 'unknown_consent_category', 'That data use is not available.');
      }
      return reply.code(201).send(result);
    },
  );

  app.delete(
    '/me/graph/nodes/:id',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const result = await deps.db.withUser(user.id, async q => {
        const { rowCount } = await q.query('DELETE FROM app.personal_graph_nodes WHERE id = $1 AND user_id = $2', [
          id,
          user.id,
        ]);
        return rowCount === 1;
      });
      if (!result) return fail(reply, 404, 'no_graph_node', 'That saved item could not be found.');
      return reply.code(204).send();
    },
  );

  app.delete(
    '/me/graph/signals/:id',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const result = await deps.db.withUser(user.id, async q => {
        const { rowCount } = await q.query('DELETE FROM app.personal_signal_events WHERE id = $1 AND user_id = $2', [
          id,
          user.id,
        ]);
        return rowCount === 1;
      });
      if (!result) return fail(reply, 404, 'no_graph_signal', 'That activity record could not be found.');
      return reply.code(204).send();
    },
  );
}
