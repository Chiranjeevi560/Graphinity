// Finishing what someone types into search (ADR 0035): Graphinity's own trigram model (ml/query-lm.ts), rebuilt
// hourly from the titles of questions anyone can see. Searches themselves are never read, so what one person typed
// can't be suggested to another; only phrasing in three or more public questions is.
import type { Database } from '../db.ts';
import { complete, trainQueryLm, type QueryLm } from '../ml/query-lm.ts';

const MAX_TITLES = 50_000;

export interface Completer {
  refresh(): Promise<number>;
  /** Drops the model: while suggestions are off, nothing stale (from questions hidden since) waits to be served. */
  clear(): void;
  complete(typed: string): string[];
}

export function createCompleter(db: Pick<Database, 'asSystem'>): Completer {
  let model: QueryLm | null = null;
  return {
    async refresh() {
      const { rows } = await db.asSystem(q =>
        q.query<{ title: string }>(
          `SELECT title FROM app.questions WHERE NOT app.is_question_hidden(id) ORDER BY id DESC LIMIT ${String(MAX_TITLES)}`,
        ),
      );
      model = trainQueryLm(rows.map(r => r.title));
      return rows.length;
    },
    clear() {
      model = null;
    },
    complete: typed => (model ? complete(model, typed) : []),
  };
}
