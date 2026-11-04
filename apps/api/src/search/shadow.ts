// Shadow scoring (the registry's SHADOW rung, ADR 0015 part 6): while a challenger ranker waits, every search that
// isn't already interleaved is ordered by it too, silently, and only the agreement and the time are kept: how much
// of its top ten matches what was shown, and how long it took. Nobody's results change, nothing about who searched or
// what is kept, and the numbers reach the owner page hourly as `search-shadow`.
import type { Database } from '../db.ts';

export const SHADOW_TOP = 10;
/** Fewer searches than this in an hour say nothing; the hour is dropped. */
export const MIN_SHADOW_SEARCHES = 50;

export interface ShadowRecorder {
  record(challenger: string, overlap: number, ms: number): void;
  flush(db: Pick<Database, 'asSystem'>): Promise<number>;
}

/** Share of the top `SHADOW_TOP` the two orders have in common (1 when both are empty). */
export function overlapAtTop(shown: readonly string[], challenger: readonly string[]): number {
  const a = new Set(shown.slice(0, SHADOW_TOP));
  const b = challenger.slice(0, SHADOW_TOP);
  const n = Math.min(a.size, b.length);
  return n ? b.filter(id => a.has(id)).length / n : 1;
}

export function createShadow(): ShadowRecorder {
  let challenger: string | null = null;
  let overlaps: number[] = [];
  let times: number[] = [];
  return {
    record(id, overlap, ms) {
      // A new challenger starts a new count: two models' numbers never mix.
      if (id !== challenger) {
        challenger = id;
        overlaps = [];
        times = [];
      }
      overlaps.push(overlap);
      times.push(ms);
    },
    async flush(db) {
      const id = challenger;
      const [o, t] = [overlaps, times];
      overlaps = [];
      times = [];
      if (!id || o.length < MIN_SHADOW_SEARCHES) return 0;
      const sorted = [...t].sort((x, y) => x - y);
      const metrics = {
        searches: o.length,
        overlapAt10: Math.round((o.reduce((s, x) => s + x, 0) / o.length) * 1000) / 1000,
        p95Ms: Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0) * 100) / 100,
        version: Number(/v(\d+)$/.exec(id)?.[1] ?? 0),
      };
      await db.asSystem(q =>
        q.query(
          `INSERT INTO app.model_evaluations (name, metrics) VALUES ('search-shadow', $1)
           ON CONFLICT (name) DO UPDATE SET metrics = excluded.metrics, evaluated_at = now()`,
          [metrics],
        ),
      );
      return o.length;
    },
  };
}
