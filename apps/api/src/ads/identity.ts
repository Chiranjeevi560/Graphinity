// The privacy layer every ad system goes through (docs/adr/0022-advertising-platform.md,
// migration 0029). Ad systems know a person only by a random ad_id, and may
// use their data for a purpose only when the database says it is permitted:
// the platform and that purpose are switched on, the rule for their country
// is approved by a lawyer and not prohibited, and the person chose it (or,
// where the law allows opting out, didn't refuse it). Run as the system.
import type { Queryable } from '../db.ts';

export const AD_PURPOSES = ['ads_personalization', 'ads_measurement', 'ads_cross_device', 'ads_partner_sites'] as const;
export type AdPurpose = (typeof AD_PURPOSES)[number];

/** Whether this person's data may be used for this purpose right now. */
export async function adsPermitted(q: Queryable, profileId: string, purpose: AdPurpose): Promise<boolean> {
  const { rows } = await q.query<{ ok: boolean }>('SELECT app.ads_permitted($1, $2) AS ok', [profileId, purpose]);
  return rows[0]?.ok === true;
}

/**
 * The person's ad_id, created the first time it is needed. It changes when
 * they turn ads_personalization off (the database rotates it in the same
 * transaction), so nothing held under the old one can be joined to them.
 */
export async function adIdentity(q: Queryable, profileId: string): Promise<string> {
  await q.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT (profile_id) DO NOTHING', [
    profileId,
  ]);
  const row = (
    await q.query<{ ad_id: string }>('SELECT ad_id::text FROM app.ad_identities WHERE profile_id = $1', [profileId])
  ).rows[0];
  if (!row) throw new Error('ad identity missing after insert');
  return row.ad_id;
}
