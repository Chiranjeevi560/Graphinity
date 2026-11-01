// Which arm a signed-in person is in, and entering them in one experiment. The unit is a keyed hash per layer, so
// outcomes can be studied without a person's id. `subject` is kept alongside it only so their rows can be deleted with
// their account or their choice: nothing compares by it.
import { createHmac } from 'node:crypto';
import type { Database, Queryable } from '../db.ts';
import { assign } from './assign.ts';

async function arms(q: Queryable, userId: string) {
  const layers = (
    await q.query<{ id: string; salt: Buffer }>('SELECT layer_id::text AS id, salt_secret AS salt FROM app.exp_layers')
  ).rows;
  const out: Array<{ id: string; experiment: string; arm: string; unit: string }> = [];
  for (const layer of layers) {
    const running = (
      await q.query<{ id: string; name: string; bucket_start: number; bucket_end: number; share: number }>(
        `SELECT exp_id::text AS id, name, bucket_start, bucket_end, control_share AS share
         FROM app.exp_definitions WHERE layer_id = $1 AND status = 'running'`,
        [layer.id],
      )
    ).rows;
    const unit = createHmac('sha256', layer.salt).update(userId).digest('base64url');
    const a = assign(
      unit,
      layer.salt.toString('base64url'),
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
    const entered = a && running.find(e => e.id === a.experiment);
    if (a && entered) out.push({ id: a.experiment, experiment: entered.name, arm: a.arm, unit });
  }
  return out;
}

/** Reads only: asking which arm you'd be in enters you in nothing. */
export async function experimentArms(
  db: Pick<Database, 'asSystem'>,
  userId: string,
): Promise<{ experiments: Array<{ experiment: string; arm: string }> }> {
  const list = await db.asSystem(q => arms(q, userId));
  return { experiments: list.map(({ experiment, arm }) => ({ experiment, arm })) };
}

/**
 * Enters a person in one named experiment, which the caller has checked they may be in, and returns their arm or null.
 * The covariate is the 14 days before the experiment began, for everyone: CUPED needs it to be untouched by the
 * experiment, and a late joiner's "14 days before entering" isn't.
 */
export async function enrol(
  db: Pick<Database, 'asSystem'>,
  userId: string,
  experiment: string,
): Promise<string | null> {
  return db.asSystem(async q => {
    const mine = (await arms(q, userId)).find(a => a.experiment === experiment);
    if (!mine) return null;
    await q.query(
      `INSERT INTO app.exp_unit_metrics (exp_id, unit_id, arm, subject, pre_experiment_covariate_x)
       SELECT $1::bigint, $2::text, $3::text, $4::uuid, count(*) FROM app.answers a, app.exp_definitions d
       WHERE d.exp_id = $1::bigint AND a.answerer_id = $4::uuid AND a.created_at < d.created_at
         AND a.created_at > d.created_at - interval '14 days'
       ON CONFLICT (exp_id, unit_id) DO NOTHING`,
      [mine.id, mine.unit, mine.arm, userId],
    );
    return mine.arm;
  });
}
