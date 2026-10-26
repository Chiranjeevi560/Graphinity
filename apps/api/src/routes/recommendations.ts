import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { FEED_VERSION, recommend } from '../recommendations/feed.ts';
import type { SearchEngine } from '../search/engine.ts';
import { signedIn } from './common.ts';

/** Consent-aware, bounded, explainable knowledge recommendations (ADR 0006, 0016); no commerce inputs. */
export function registerRecommendationRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    enabled: () => boolean;
    engine: SearchEngine;
    /** The model whose vectors "similar to a question you opened" compares; null without one. */
    meaningModel: () => string | null;
  },
) {
  app.get('/me/recommendations', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    if (!deps.enabled())
      return { enabled: false, availability: 'unavailable', algorithmVersion: FEED_VERSION, recommendations: [] };
    const result = await recommend(deps, user.id);
    return { ...result, algorithmVersion: FEED_VERSION };
  });
}
