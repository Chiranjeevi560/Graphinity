// Choosing ads (docs/adr/0022-advertising-platform.md part 4). Active
// campaigns are held in memory and refreshed every REFRESH_MS: campaigns
// that may serve now (active, inside their dates, their business approved,
// at least one approved ad), their targeting, the last 30 days' impressions
// and clicks (for click rates) and today's spend (for pacing). A request:
// 1. candidates whose every targeting kind matches the context (topic, a
//    query word, the reader's country, and interest only when the reader
//    allows personalized ads);
// 2. paced: a campaign sits out while it is spending ahead of the day;
// 3. capped: a reader who allows personalized ads sees one campaign at most
//    its frequency cap a day; nobody else is tracked, so has no cap. An ad
//    reminder (a campaign targeting a retargeting audience, part 7) is
//    capped harder, 3 a day and 7 a week, and its click rate cools with time
//    since the tap that put the reader in the audience;
// 4. the auction (auction.ts), whose winners are recorded as impressions.
// Ads never pass through knowledge ranking, and it never sees them.
import type { Database, Queryable } from '../db.ts';
import { tokenize } from '../ml/text-embedding.ts';
import { deserializeServing, predictServing, type FtrlServing } from '../ml/ftrl.ts';
import { loadServing } from '../ml/registry.ts';
import { paced, runAuction, shrunkCtr, type Candidate, type Win } from './auction.ts';
import { AD_CTR, ctrFeatures } from './ctr-features.ts';
import { cooling, RETARGET_PER_DAY, RETARGET_PER_WEEK } from './audiences.ts';

export const REFRESH_MS = 30_000;
/** A click rate to start from: the prior is worth this many impressions. */
export const PRIOR_CTR = 0.02;
export const PRIOR_STRENGTH = 200;
export const RESERVE_MICROS = 10_000;
export const SLOTS = { search: 2, question: 1 } as const;
export type Placement = keyof typeof SLOTS;

interface Creative {
  id: string;
  headline: string;
  body: string;
  domain: string;
}

export interface IndexedCampaign {
  id: string;
  advertiser: string;
  advertiserId: string;
  maxCpcMicros: number;
  dailyBudgetMicros: number;
  frequencyCap: number;
  spentMicros: number;
  impressions: number;
  clicks: number;
  creatives: Creative[];
  /** Targeting by kind; a kind absent means "anything". */
  targets: Map<string, Set<string>>;
  /** The targeted audiences that are ad reminders (part 7): capped harder, cooling with time. */
  reminders: ReadonlySet<string>;
}

export interface AdContext {
  placement: Placement;
  /** Topics of what the reader is looking at. */
  fields: readonly string[];
  /** Words of the query, for keyword targeting. */
  words: readonly string[];
  country: string | null;
  /** The reader's interest topics, only when they allow personalized ads; else null. */
  interests: ReadonlySet<string> | null;
  /**
   * The ready audiences the reader is in, with when they joined (ms), only when they allow
   * personalized ads and audiences are on; else null.
   */
  audiences?: ReadonlyMap<string, number> | null;
}

/** Whether every targeting kind the campaign uses matches this context. */
export function matches(c: IndexedCampaign, ctx: AdContext): boolean {
  for (const [kind, values] of c.targets) {
    if (kind === 'field' && !ctx.fields.some(f => values.has(f))) return false;
    if (kind === 'keyword' && !ctx.words.some(w => values.has(w))) return false;
    if (kind === 'country' && (ctx.country === null || !values.has(ctx.country))) return false;
    if (kind === 'interest' && (ctx.interests === null || ![...values].some(v => ctx.interests?.has(v)))) return false;
    if (kind === 'audience' && ![...values].some(v => ctx.audiences?.has(v) ?? false)) return false;
  }
  return true;
}

/**
 * For an ad reminder the reader qualifies for, how long ago they joined its audience (ms);
 * null when the campaign is no reminder for them.
 */
function reminderAge(c: IndexedCampaign, ctx: AdContext, now: number): number | null {
  let latest = -Infinity;
  for (const a of c.reminders) latest = Math.max(latest, ctx.audiences?.get(a) ?? -Infinity);
  return latest === -Infinity ? null : now - latest;
}

/** Fraction of the UTC day gone, for pacing. */
const dayFraction = (now: number) => (now % 86_400_000) / 86_400_000;

export interface Selection {
  wins: Win[];
  /** The winning ads' text, by creative id. */
  creatives: Map<string, Creative & { advertiser: string }>;
}

/**
 * Campaigns by the topics they target, and those targeting no topic: a
 * request then scans only campaigns that could match its topics, not every
 * campaign (measured: 6 ms a request at 100,000 campaigns scanned whole,
 * scripts/benchmark-ad-serving.mjs).
 */
export interface CampaignIndex {
  byField: Map<string, IndexedCampaign[]>;
  anyField: IndexedCampaign[];
}

export function indexCampaigns(campaigns: readonly IndexedCampaign[]): CampaignIndex {
  const byField = new Map<string, IndexedCampaign[]>();
  const anyField: IndexedCampaign[] = [];
  for (const c of campaigns) {
    const fields = c.targets.get('field');
    if (!fields) {
      anyField.push(c);
      continue;
    }
    for (const f of fields) {
      const list = byField.get(f) ?? [];
      list.push(c);
      byField.set(f, list);
    }
  }
  return { byField, anyField };
}

/** The campaigns a context could match: its topics' lists and the untargeted ones, each once. */
function candidatesFor(index: CampaignIndex, ctx: AdContext): IndexedCampaign[] {
  const seen = new Set<string>();
  const out: IndexedCampaign[] = [];
  for (const list of [index.anyField, ...ctx.fields.map(f => index.byField.get(f) ?? [])])
    for (const c of list)
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
  return out;
}

/** Pure: candidates, pacing, caps and the auction, over an index snapshot. */
export function choose(
  index: CampaignIndex,
  ctx: AdContext,
  seenToday: ReadonlyMap<string, number>,
  now: number,
  /** A learned click model (part 5): per campaign, ad and context. Without one, shrunk averages. */
  predictCtr?: (campaign: string, creative: string, ctx: AdContext) => number,
  /** Impressions per campaign this reader saw in the last 7 days (reminders' weekly cap). */
  seenThisWeek: ReadonlyMap<string, number> = new Map(),
): Selection {
  const candidates: Candidate[] = [];
  const creatives = new Map<string, Creative & { advertiser: string }>();
  for (const c of candidatesFor(index, ctx)) {
    if (!matches(c, ctx)) continue;
    if (!paced(c.spentMicros, c.dailyBudgetMicros, dayFraction(now))) continue;
    const age = reminderAge(c, ctx, now);
    const dailyCap = age === null ? c.frequencyCap : Math.min(c.frequencyCap, RETARGET_PER_DAY);
    if ((seenToday.get(c.id) ?? 0) >= dailyCap) continue;
    if (age !== null && (seenThisWeek.get(c.id) ?? 0) >= RETARGET_PER_WEEK) continue;
    const shrunk = shrunkCtr(c.clicks, c.impressions, PRIOR_CTR, PRIOR_STRENGTH);
    const cool = age === null ? 1 : cooling(age);
    for (const cr of c.creatives) {
      const ctr = (predictCtr ? predictCtr(c.id, cr.id, ctx) : shrunk) * cool;
      candidates.push({ campaignId: c.id, creativeId: cr.id, maxCpcMicros: c.maxCpcMicros, ctr });
      creatives.set(cr.id, { ...cr, advertiser: c.advertiser });
    }
  }
  return { wins: runAuction(candidates, { slots: SLOTS[ctx.placement], reserveMicros: RESERVE_MICROS }), creatives };
}

/** The campaigns that may serve now, with what pacing and click rates need. As the system. */
export async function loadIndex(q: Queryable): Promise<IndexedCampaign[]> {
  const { rows } = await q.query<{
    id: string;
    advertiser: string;
    advertiser_id: string;
    max_cpc_micros: string;
    daily_budget_micros: string;
    frequency_cap: number;
    spent: string;
    impressions: string;
    clicks: string;
    creatives: Array<{ id: string; headline: string; body: string; url: string }>;
    targets: Array<{ kind: string; value: string; reminder: boolean }> | null;
  }>(
    `SELECT c.id::text, a.name AS advertiser, a.id::text AS advertiser_id, c.max_cpc_micros::text,
            c.daily_budget_micros::text, c.frequency_cap,
            coalesce((SELECT sum(i.charged_micros) FROM app.ad_impressions i
                      WHERE i.campaign_id = c.id AND i.shown_at >= date_trunc('day', now(), 'UTC')), 0)::text AS spent,
            (SELECT count(*) FROM app.ad_impressions i WHERE i.campaign_id = c.id AND i.shown_at > now() - interval '30 days')::text AS impressions,
            (SELECT count(*) FROM app.ad_impressions i WHERE i.campaign_id = c.id AND i.shown_at > now() - interval '30 days'
               AND i.clicked_at IS NOT NULL)::text AS clicks,
            (SELECT json_agg(json_build_object('id', cr.id::text, 'headline', cr.headline, 'body', cr.body, 'url', cr.destination_url)
                             ORDER BY cr.id)
             FROM app.ad_creatives cr WHERE cr.campaign_id = c.id AND cr.status = 'approved') AS creatives,
            (SELECT json_agg(json_build_object('kind', t.kind, 'value', t.value, 'reminder', t.kind = 'audience' AND EXISTS (
                SELECT 1 FROM app.ad_audiences au WHERE au.public_id::text = t.value AND au.kind = 'retargeting')))
             FROM app.ad_targeting t WHERE t.campaign_id = c.id) AS targets
     FROM app.ad_campaigns c JOIN app.ad_advertisers a ON a.id = c.advertiser_id
     WHERE c.status = 'active' AND a.status = 'active' AND c.starts_at <= now() AND (c.ends_at IS NULL OR c.ends_at > now())
       AND EXISTS (SELECT 1 FROM app.ad_creatives cr WHERE cr.campaign_id = c.id AND cr.status = 'approved')
       AND (c.total_budget_micros IS NULL OR c.total_budget_micros >
            (SELECT coalesce(sum(i.charged_micros), 0) FROM app.ad_impressions i WHERE i.campaign_id = c.id))`,
  );
  return rows.map(r => {
    const targets = new Map<string, Set<string>>();
    const reminders = new Set<string>();
    for (const t of r.targets ?? []) {
      const set = targets.get(t.kind) ?? new Set<string>();
      set.add(t.value);
      targets.set(t.kind, set);
      if (t.reminder) reminders.add(t.value);
    }
    return {
      id: r.id,
      advertiser: r.advertiser,
      advertiserId: r.advertiser_id,
      maxCpcMicros: Number(r.max_cpc_micros),
      dailyBudgetMicros: Number(r.daily_budget_micros),
      frequencyCap: r.frequency_cap,
      spentMicros: Number(r.spent),
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      creatives: r.creatives.map(c => ({
        id: c.id,
        headline: c.headline,
        body: c.body,
        domain: new URL(c.url).hostname,
      })),
      targets,
      reminders,
    };
  });
}

export interface ServedAd {
  token: string;
  headline: string;
  body: string;
  domain: string;
  advertiser: string;
}

export interface AdServer {
  serve(input: {
    placement: Placement;
    fields: readonly string[];
    query: string | null;
    viewer: string | null;
    now: number;
  }): Promise<ServedAd[]>;
  /** Re-reads the campaigns now (also every REFRESH_MS). */
  refresh(): Promise<void>;
}

export function createAdServer(db: Pick<Database, 'asSystem'>): AdServer {
  let index: CampaignIndex = indexCampaigns([]);
  let size = 0;
  let loadedAt = -Infinity;
  let model: FtrlServing | null = null;
  const refresh = async () => {
    const campaigns = await db.asSystem(loadIndex);
    index = indexCampaigns(campaigns);
    size = campaigns.length;
    // The promoted click model, checked against its stored hash; none until one earns its place.
    const serving = await loadServing(db, AD_CTR);
    model = serving ? deserializeServing(serving.artifact) : null;
    loadedAt = Date.now();
  };
  return {
    refresh,
    async serve({ placement, fields, query, viewer, now }) {
      if (Date.now() - loadedAt > REFRESH_MS) await refresh();
      if (size === 0) return [];
      return db.asSystem(async q => {
        // Who the reader is to ad systems, only if they allow personalized ads.
        const person = viewer
          ? (
              await q.query<{ country: string | null; personalized: boolean }>(
                `SELECT p.country, app.ads_permitted(p.id, 'ads_personalization') AS personalized
                 FROM app.profiles p WHERE p.id = $1`,
                [viewer],
              )
            ).rows[0]
          : undefined;
        let adId: string | null = null;
        let interests: Set<string> | null = null;
        let audiences: Map<string, number> | null = null;
        const seenToday = new Map<string, number>();
        const seenThisWeek = new Map<string, number>();
        if (viewer && person?.personalized) {
          await q.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [viewer]);
          adId =
            (
              await q.query<{ ad_id: string }>('SELECT ad_id::text FROM app.ad_identities WHERE profile_id = $1', [
                viewer,
              ])
            ).rows[0]?.ad_id ?? null;
          interests = new Set(
            (
              await q.query<{ field: string }>(
                'SELECT field FROM app.ad_interests WHERE ad_id = $1 AND app.decayed(score, updated_at) >= 0.5',
                [adId],
              )
            ).rows.map(r => r.field),
          );
          for (const r of (
            await q.query<{ campaign_id: string; today: number; week: number }>(
              `SELECT campaign_id::text,
                      count(*) FILTER (WHERE shown_at >= date_trunc('day', now(), 'UTC'))::int AS today,
                      count(*)::int AS week
               FROM app.ad_impressions WHERE ad_id = $1 AND shown_at > now() - interval '7 days' GROUP BY campaign_id`,
              [adId],
            )
          ).rows) {
            seenToday.set(r.campaign_id, r.today);
            seenThisWeek.set(r.campaign_id, r.week);
          }
          // The ready audiences they're in, only while audiences are on.
          audiences = new Map(
            (
              await q.query<{ audience: string; at: Date }>(
                `SELECT a.public_id::text AS audience, m.event_at AS at
                 FROM app.ad_audience_members m JOIN app.ad_audiences a ON a.id = m.audience_id
                 WHERE m.ad_id = $1 AND a.status = 'ready' AND app.flag_on('ads_audiences')`,
                [adId],
              )
            ).rows.map(r => [r.audience, r.at.getTime()]),
          );
        }
        const { wins, creatives } = choose(
          index,
          {
            placement,
            fields,
            words: query ? tokenize(query) : [],
            country: person?.country ?? null,
            interests,
            audiences,
          },
          seenToday,
          now,
          model
            ? (campaign, creative, c) =>
                predictServing(
                  model as FtrlServing,
                  ctrFeatures({
                    campaign,
                    creative,
                    placement,
                    field: c.fields[0] ?? null,
                    hour: new Date(now).getUTCHours(),
                  }),
                )
            : undefined,
          seenThisWeek,
        );
        const served: ServedAd[] = [];
        for (const w of wins) {
          const cr = creatives.get(w.creativeId);
          if (!cr) continue;
          const token = (
            await q.query<{ token: string }>(
              `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, field)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING token::text`,
              [w.campaignId, w.creativeId, adId, placement, w.priceMicros, fields[0] ?? null],
            )
          ).rows[0]?.token;
          if (token)
            served.push({ token, headline: cr.headline, body: cr.body, domain: cr.domain, advertiser: cr.advertiser });
        }
        return served;
      });
    },
  };
}
