// GET /search/complete (ADR 0035): ways to finish what was typed, from public question titles only. Off by default.
// Nothing typed here is stored or logged: the logger never sees a query string, and this route keeps nothing.
import type { FastifyInstance } from 'fastify';
import type { Completer } from '../search/completion.ts';
import { fail } from './common.ts';

export function registerCompletionRoutes(
  app: FastifyInstance,
  deps: { enabled: () => boolean; completer: Completer | null },
) {
  app.get(
    '/search/complete',
    {
      config: { auth: 'optional' },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1, maxLength: 150 } },
        },
      },
    },
    async (req, reply) => {
      const completer = deps.completer;
      if (!deps.enabled() || !completer)
        return fail(reply, 404, 'completion_off', 'Search suggestions aren’t available yet.');
      // Suggestions change hourly, never per person: a shared cache can't leak anything personal.
      reply.header('cache-control', 'public, max-age=300');
      return { suggestions: completer.complete((req.query as { q: string }).q) };
    },
  );
}
