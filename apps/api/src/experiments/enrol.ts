// Putting a signed-in person in the experiments that are running, and recording what the comparison needs. The unit is
// a keyed hash per layer, so a person's rows in one experiment can't be joined to another's.
import { createHmac } from 'node:crypto';
import type { Database } from '../db.ts';
import { assign } from './assign.ts';

export async function enrol(
  db: Pick<Database, 'asSystem'>,
  userId: string,
): Promise<{ experiments: Array<{ experiment: string; arm: string }> }> {
  return db.asSystem(async q => {
    const layers = (
      await q.query<{ id: string; salt: Buffer }>(
        'SELECT layer_id::text AS id, salt_secret AS salt FROM app.exp_layers',
      )
    ).rows;
    const out: Array<{ experiment: string; arm: string }> = [];
    for (const layer of layers) {
      const running = (
        await q.query<{ id: string; name: string; bucket_start: number; bucket_end: number; share: number }>(
          `SELECT exp_id::text AS id, name, bucket_start, bucket_end, control_share AS share
           FROM app.exp_definitions WHERE layer_id = $1 AND status = 'running'`,
          [layer.id],
        )
      ).rows;
      const salt = layer.salt.toString('base64url');
      const unit = createHmac('sha256', layer.salt).update(userId).digest('base64url');
      const a = assign(
        unit,
        salt,
        running.map(e => ({
          id: e.id,
          bucketStart: e.bucket_start,
          bucketEnd: e.bucket_end,
          arms: [
            { name: 'control', weight: e.share },
            { name: 'treatment', weight: 1 - e.share },
          ],
        })),
      );
      if (!a) continue;
      const entered = running.find(e => e.id === a.experiment);
      // The metric: answers given since entering, and in the 14 days before (CUPED's covariate).
      await q.query(
        `INSERT INTO app.exp_unit_metrics (exp_id, unit_id, arm, subject, pre_experiment_covariate_x)
         VALUES ($1, $2, $3, $4, (SELECT count(*) FROM app.answers WHERE answerer_id = $4 AND created_at > now() - interval '14 days' AND created_at <= now()))
         ON CONFLICT (exp_id, unit_id) DO NOTHING`,
        [a.experiment, unit, a.arm, userId],
      );
      await q.query(
        `UPDATE app.exp_unit_metrics m SET post_metric_y = (SELECT count(*) FROM app.answers a WHERE a.answerer_id = $3
           AND a.created_at > (SELECT created_at FROM app.exp_definitions WHERE exp_id = $1)), updated_at = now()
         WHERE m.exp_id = $1 AND m.unit_id = $2`,
        [a.experiment, unit, userId],
      );
      if (entered) out.push({ experiment: entered.name, arm: a.arm });
    }
    return { experiments: out };
  });
}
