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
import { createHmac } from 'node:crypto';
import type { Exchange, Partner } from './exchange.ts';
import { buildBidRequest, SENSITIVE_FIELDS } from './openrtb.ts';
import { eid, floors, merge, type SlotOutcome } from './rtb.ts';
import { pacedBid } from './pacing.ts';
import { heldOut } from './lift.ts';
import { murmur3 } from '../experiments/murmur.ts';
import { calibrate, deserializeCalibration, type Calibration } from '../ml/isotonic.ts';

export const REFRESH_MS = 30_000;
/** A click rate to start from: the prior is worth this many impressions. */
export const PRIOR_CTR = 0.02;
export const PRIOR_STRENGTH = 200;
export const RESERVE_MICROS = 10_000;
export const SLOTS = { search: 2, question: 1 } as const;
/** Share of each campaign's reachable people held out to measure what it adds (ghost ads). */
export const HOLDOUT_SHARE = 0.1;
/** A campaign targeting a topic the reader just came for, from outside (charter: inbound signals). */
export const INBOUND_BOOST = 3.5;
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
  /** Primal-dual pacing's λ while it runs (pacing.ts); null: the on/off rule. */
  lambda?: number | null;
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
  /** Topics the reader came for from outside, only when they allow partner sites; else absent. */
  inbound?: ReadonlySet<string>;
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
    const lambda = c.lambda ?? null;
    if (lambda === null && !paced(c.spentMicros, c.dailyBudgetMicros, dayFraction(now))) continue;
    if (c.spentMicros >= c.dailyBudgetMicros) continue;
    const age = reminderAge(c, ctx, now);
    const dailyCap = age === null ? c.frequencyCap : Math.min(c.frequencyCap, RETARGET_PER_DAY);
    if ((seenToday.get(c.id) ?? 0) >= dailyCap) continue;
    if (age !== null && (seenThisWeek.get(c.id) ?? 0) >= RETARGET_PER_WEEK) continue;
    const shrunk = shrunkCtr(c.clicks, c.impressions, PRIOR_CTR, PRIOR_STRENGTH);
    const fieldTargets = c.targets.get('field');
    const boost = fieldTargets && [...(ctx.inbound ?? [])].some(f => fieldTargets.has(f)) ? INBOUND_BOOST : 1;
    const cool = (age === null ? 1 : cooling(age)) * boost;
    const bid = lambda === null ? c.maxCpcMicros : Math.max(1, pacedBid(c.maxCpcMicros, lambda));
    for (const cr of c.creatives) {
      const ctr = (predictCtr ? predictCtr(c.id, cr.id, ctx) : shrunk) * cool;
      candidates.push({ campaignId: c.id, creativeId: cr.id, maxCpcMicros: bid, ctr });
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
    lambda: number | null;
    spent: string;
    impressions: string;
    clicks: string;
    creatives: Array<{ id: string; headline: string; body: string; url: string }>;
    targets: Array<{ kind: string; value: string; reminder: boolean }> | null;
  }>(
    `SELECT c.id::text, a.name AS advertiser, a.id::text AS advertiser_id, c.max_cpc_micros::text,
            c.daily_budget_micros::text, c.frequency_cap,
            CASE WHEN app.flag_on('ads_pacing') THEN
              (SELECT p.lambda FROM app.ad_pacing p WHERE p.campaign_id = c.id AND p.day = (now() AT TIME ZONE 'UTC')::date)
            END AS lambda,
            coalesce((SELECT sum(i.charged_micros) FROM app.ad_impressions i
                      WHERE i.campaign_id = c.id AND i.charged_at >= date_trunc('day', now(), 'UTC')), 0)::text AS spent,
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
       AND (c.total_budget_micros IS NULL OR c.total_budget_micros > c.spent_total_micros)`,
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
      lambda: r.lambda,
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

export interface ServeInput {
  placement: Placement;
  fields: readonly string[];
  query: string | null;
  viewer: string | null;
  now: number;
  /** What a bidder may know of the page: a path holding no words of it. */
  path?: string;
  /** Only used for a reader who allows partner sites, and only cut down (openrtb.ts). */
  ip?: string | null;
  userAgent?: string | null;
  /** The browser sent Sec-GPC: 1. Nothing about this reader is personalized or shared. */
  gpc?: boolean;
  /** Words and topics the page saw on arrival from outside; used only with partner-sites consent, never stored. */
  inbound?: { words: readonly string[]; fields: readonly string[] };
}

/** Outside bidders (part 9a), absent where they aren't configured. */
export interface RtbOptions {
  enabled: () => boolean;
  exchange: Exchange;
  /** Keys the rotating extended ids. */
  secret: Buffer;
  /** Graphinity's own host name. */
  site: string;
  currency: string;
}

export interface AdServer {
  serve(input: ServeInput): Promise<ServedAd[]>;
  /** Re-reads the campaigns now (also every REFRESH_MS). */
  refresh(): Promise<void>;
  /** A rotating id for a tap's destination, only for one who allows partner sites. */
  tapEid?(viewer: string, now: number, userAgent: string | null, token: string): Promise<string | null>;
}

export function createAdServer(db: Pick<Database, 'asSystem'>, rtb?: RtbOptions): AdServer {
  let index: CampaignIndex = indexCampaigns([]);
  let byId = new Map<string, IndexedCampaign>();
  let size = 0;
  let loadedAt = -Infinity;
  let model: FtrlServing | null = null;
  let partners: Partner[] = [];
  let calibration: Calibration | null = null;
  const holdoutOn = async () =>
    db.asSystem(
      async q => (await q.query<{ on: boolean }>("SELECT app.flag_on('ads_holdout') AS on")).rows[0]?.on === true,
    );
  const eidOf = (secret: Buffer, adId: string, now: number, crossDevice: boolean, ua: string | null, scope: string) =>
    eid(
      secret,
      adId,
      now,
      crossDevice
        ? null
        : createHmac('sha256', secret)
            .update(ua ?? '')
            .digest('base64url'),
      scope,
    );
  const rememberEid = (q: Queryable, id: string, adId: string, now: number, scope: string) =>
    q.query(
      `INSERT INTO app.ad_eids (eid, ad_id, expires_at, scope) VALUES ($1, $2, $3, $4) ON CONFLICT (eid) DO NOTHING`,
      [id, adId, new Date(now + 62 * 86_400_000), scope],
    );
  const refresh = async () => {
    const campaigns = await db.asSystem(loadIndex);
    index = indexCampaigns(campaigns);
    byId = new Map(campaigns.map(c => [c.id, c]));
    size = campaigns.length;
    // The promoted click model, checked against its stored hash; none until one earns its place.
    const serving = await loadServing(db, AD_CTR);
    model = serving ? deserializeServing(serving.artifact) : null;
    const curve = serving?.calibration;
    calibration = curve ? deserializeCalibration(curve) : null;
    partners = rtb?.enabled()
      ? await db.asSystem(
          async q =>
            (
              await q.query<Partner>(
                'SELECT p.id::text AS id, endpoint FROM app.ad_partners p WHERE enabled ORDER BY p.id',
              )
            ).rows,
        )
      : [];
    loadedAt = Date.now();
  };
  return {
    refresh,
    async tapEid(viewer, now, userAgent, token) {
      if (!rtb) return null;
      const { secret } = rtb;
      return db.asSystem(async q => {
        const r = (
          await q.query<{ ad_id: string; cross: boolean; advertiser: string }>(
            `SELECT i.ad_id::text, app.ads_permitted(i.profile_id, 'ads_cross_device') AS cross, c.advertiser_id::text AS advertiser
             FROM app.ad_identities i
             JOIN app.ad_impressions imp ON imp.token = $2
             JOIN app.ad_campaigns c ON c.id = imp.campaign_id
             WHERE i.profile_id = $1 AND app.ads_permitted(i.profile_id, 'ads_personalization')
               AND app.ads_permitted(i.profile_id, 'ads_partner_sites')`,
            [viewer, token],
          )
        ).rows[0];
        if (!r) return null;
        const scope = `advertiser:${r.advertiser}`;
        const id = eidOf(secret, r.ad_id, now, r.cross, userAgent, scope);
        await rememberEid(q, id, r.ad_id, now, scope);
        return id;
      });
    },
    async serve(input) {
      const { placement, fields, query, viewer, now, gpc = false } = input;
      if (Date.now() - loadedAt > REFRESH_MS) await refresh();
      const offering = rtb?.enabled() === true && partners.length > 0 && !fields.some(f => SENSITIVE_FIELDS.has(f));
      if (size === 0 && !offering) return [];
      // Read, then ask bidders holding no database connection, then write: a slow partner
      // must never tie up one of the pool's few connections.
      const context = await db.asSystem(async q => {
        // Who the reader is to ad systems, only if they allow personalized ads.
        const person = viewer
          ? (
              await q.query<{
                country: string | null;
                personalized: boolean;
                measured: boolean;
                partnerSites: boolean;
                crossDevice: boolean;
              }>(
                `SELECT p.country, app.ads_permitted(p.id, 'ads_personalization') AS personalized,
                        app.ads_permitted(p.id, 'ads_measurement') AS measured,
                        app.ads_permitted(p.id, 'ads_partner_sites') AS "partnerSites",
                        app.ads_permitted(p.id, 'ads_cross_device') AS "crossDevice"
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
        // An impression that may be measured needs an identity too: it's how the row is found again when they withdraw.
        if (viewer && (person?.personalized || person?.measured) && !gpc) {
          await q.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [viewer]);
          adId =
            (
              await q.query<{ ad_id: string }>('SELECT ad_id::text FROM app.ad_identities WHERE profile_id = $1', [
                viewer,
              ])
            ).rows[0]?.ad_id ?? null;
        }
        if (viewer && person?.personalized && !gpc) {
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
        return { person, adId, interests, audiences, seenToday, seenThisWeek };
      });
      const { person, adId, interests, audiences, seenToday, seenThisWeek } = context;
      // Outside signals count only with this reader's partner-sites permission, and are never stored. An identity alone
      // isn't enough: someone who allows only measurement has one too, and didn't ask for personal ads.
      const shared = adId !== null && person?.personalized === true && person.partnerSites;
      const inbound = shared ? input.inbound : undefined;
      const { wins, creatives } = choose(
        index,
        {
          placement,
          fields,
          words: [...(query ? tokenize(query) : []), ...(inbound?.words ?? [])],
          country: person?.country ?? null,
          interests,
          audiences,
          ...(inbound ? { inbound: new Set(inbound.fields) } : {}),
        },
        seenToday,
        now,
        model
          ? (campaign, creative, c) => {
              const raw = predictServing(
                model as FtrlServing,
                ctrFeatures({
                  campaign,
                  creative,
                  placement,
                  field: c.fields[0] ?? null,
                  hour: new Date(now).getUTCHours(),
                }),
              );
              return calibration ? calibrate(calibration, raw) : raw;
            }
          : undefined,
        seenThisWeek,
      );
      // A randomized tenth of tracked readers see no ad from a campaign they'd have got; the win is
      // recorded as a ghost, so its effect can be measured against people who did see it.
      const ghosts =
        adId !== null && wins.length > 0 && (await holdoutOn())
          ? wins.filter(w => heldOut(murmur3(`${adId}:${w.campaignId}`), HOLDOUT_SHARE))
          : [];
      const visible = ghosts.length ? wins.filter(w => !ghosts.includes(w)) : wins;
      let outcomes: SlotOutcome[] = visible.map(win => ({ kind: 'own', win }));
      if (offering) {
        const slots = SLOTS[placement];
        const reserveCpm = RESERVE_MICROS / 1000;
        const slotFloors = floors(visible, slots, reserveCpm);
        const shares = shared;
        const crossDevice = person?.crossDevice === true;
        const offerTo = (scope: string) =>
          buildBidRequest({
            placement,
            slots,
            floorCpm: Math.min(...slotFloors),
            currency: rtb.currency,
            fields,
            path: input.path ?? '/',
            country: person?.country ?? null,
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
            partner:
              shares && adId
                ? {
                    eid: eidOf(rtb.secret, adId, now, crossDevice, input.userAgent ?? null, scope),
                    crossDevice,
                    interests: [...(interests ?? [])],
                  }
                : null,
            test: false,
            site: rtb.site,
          });
        // With an id in it, each bidder gets its own; without, one request serves them all.
        const bids = shares
          ? (await Promise.all(partners.map(p => rtb.exchange.ask([p], offerTo(`partner:${p.id}`))))).flat()
          : await rtb.exchange.ask(partners, offerTo(''));
        outcomes = merge(visible, bids, slotFloors);
      }
      const currency = rtb?.currency ?? 'INR';
      return db.asSystem(async q => {
        for (const g of ghosts)
          await q.query(
            'INSERT INTO app.ad_ghost_impressions (campaign_id, ad_id, counterfactual_micros) VALUES ($1, $2, $3)',
            [g.campaignId, adId, g.priceMicros],
          );
        const served: ServedAd[] = [];
        for (const outcome of outcomes) {
          if (outcome.kind === 'partner') {
            const { bid, priceMicros } = outcome;
            const token = (
              await q.query<{ token: string }>(
                `INSERT INTO app.ad_partner_impressions (partner_id, placement, price_micros, currency, destination_url, domain)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING token::text`,
                [bid.partner, placement, priceMicros, currency, bid.url, bid.domain],
              )
            ).rows[0]?.token;
            if (token)
              served.push({
                token,
                headline: bid.headline,
                body: bid.body,
                domain: bid.domain,
                advertiser: bid.domain,
              });
            continue;
          }
          const w = outcome.win;
          const cr = creatives.get(w.creativeId);
          if (!cr) continue;
          // For private reports (part 8): the reader's country, and which of the campaign's
          // audiences they were reached through.
          const audience = [...(byId.get(w.campaignId)?.targets.get('audience') ?? [])].find(a => audiences?.has(a));
          const token = (
            await q.query<{ token: string }>(
              `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, field, country, audience_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT id FROM app.ad_audiences WHERE public_id = $8))
               RETURNING token::text`,
              [
                w.campaignId,
                w.creativeId,
                adId,
                placement,
                w.priceMicros,
                fields[0] ?? null,
                person?.country ?? null,
                audience ?? null,
              ],
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
