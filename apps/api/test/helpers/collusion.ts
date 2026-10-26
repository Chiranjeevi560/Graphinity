// Puts accounts in an open collusion group (migration 0025), as the job
// would, straight through the owner. Returns a function that removes it.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export async function underReview(owner: pg.Client, ids: readonly string[]): Promise<() => Promise<void>> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO app.collusion_groups (member_key, members, inside, expected, lift)
     VALUES ($1, 3, 6, 0.1, 60) RETURNING id::text`,
    [randomBytes(32).toString('hex')],
  );
  const id = rows[0]?.id ?? '';
  await owner.query('INSERT INTO app.collusion_members (group_id, profile_id) SELECT $1, unnest($2::uuid[])', [
    id,
    ids,
  ]);
  return async () => {
    await owner.query('DELETE FROM app.collusion_groups WHERE id = $1', [id]);
  };
}
