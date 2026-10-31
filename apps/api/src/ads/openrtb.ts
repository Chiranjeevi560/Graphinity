// OpenRTB 2.6 (docs/adr/0022-advertising-platform.md part 9a): offering an ad
// slot to outside bidders, and reading their bids. Field names, enumerations
// and taxonomies follow the IAB Tech Lab's published OpenRTB 2.6 and AdCOM
// 1.0 texts (checked 2026-10-27), not memory.
//
// What leaves Graphinity, by consent:
// - always: the page's topics as IAB Content Taxonomy 3.0 categories, the
//   placement, a coarse device type, the floor price, and the regulations
//   flags. Never a user agent string, a full address, an account id, a
//   handle or the page's words.
// - only for a reader who allows partner sites (ads_partner_sites): their
//   interest topics as IAB Audience Taxonomy 1.1 segments (Seller-Defined
//   Audiences), a rotating extended id (EID), and their IP address cut to
//   /24 (IPv4) or /48 (IPv6).
// - never: health, immigration or legal topics, whoever allows what: they
//   are special categories of data under GDPR Art. 9 and sensitive under
//   DPDP, and a bidder has no business with them.
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

/** AdCOM 1.0 List: Category Taxonomies. */
export const CATTAX_CONTENT_3_0 = 7;
export const SEGTAX_AUDIENCE_1_1 = 4;
/** AdCOM 1.0 List: Device Types. */
export const DEVICE = { pc: 2, phone: 4, tablet: 5 } as const;
/** AdCOM 1.0 List: Agent Types: 1 browser or device, 3 person (same across devices). */
export const AGENT = { browser: 1, person: 3 } as const;
/** BidRequest.at: 2 = second price plus. */
export const SECOND_PRICE = 2;
/** How long bidders get, in ms (BidRequest.tmax); the adapter stops listening at this too. */
export const TMAX_MS = 60;

/** Topics never sent to a bidder, as page categories or as audience segments. */
export const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'health-hospitals',
  'visas-immigration',
  'legal-matters',
]);

/** Graphinity topic → IAB Content Taxonomy 3.0 unique ID (Content Taxonomy 3.0.tsv). */
export const CONTENT_CATEGORY: Readonly<Record<string, string>> = {
  'business-startups': '61',
  'cars-vehicles': '1',
  fitness: '225',
  'food-cooking': '216',
  'government-services': '394',
  'housing-renting': '452',
  'imports-customs': '52',
  'jobs-careers': '127',
  'money-tax': '415',
  'parenting-schools': '192',
  'phones-gadgets': '632',
  shopping: '473',
  'software-programming': '602',
  'study-abroad': '132',
  travel: '653',
  'watches-luxury': '552',
};

/** Graphinity topic → IAB Audience Taxonomy 1.1 interest segment (Audience Taxonomy 1.1.tsv). */
export const AUDIENCE_SEGMENT: Readonly<Record<string, string>> = {
  'business-startups': '268',
  'cars-vehicles': '243',
  fitness: '406',
  'food-cooking': '368',
  'housing-renting': '583',
  'imports-customs': '606',
  'jobs-careers': '338',
  'money-tax': '534',
  'parenting-schools': '348',
  'phones-gadgets': '687',
  shopping: '606',
  'software-programming': '687',
  'study-abroad': '344',
  travel: '719',
  'watches-luxury': '676',
};

/** EU and EEA countries, where GDPR applies (Regs.gdpr = 1). */
const GDPR = new Set(
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' '),
);

/** An IP address with its host part removed: IPv4 to /24, IPv6 to /48. Anything else: nothing. */
export function truncateIp(ip: string | null | undefined): { ip?: string; ipv6?: string } {
  if (!ip) return {};
  const v4 = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v4) === 4) return { ip: `${v4.split('.').slice(0, 3).join('.')}.0` };
  if (isIP(ip) !== 6) return {};
  // Expand "::" to full groups, keep the first three, zero the rest.
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
  return {
    ipv6: `${groups
      .slice(0, 3)
      .map(g => g.toLowerCase().replace(/^0+(?=.)/, ''))
      .join(':')}::`,
  };
}

/** A coarse device type from a user agent; the string itself never leaves. */
export function deviceType(ua: string | null | undefined): number {
  if (!ua) return DEVICE.pc;
  if (/iPad|Tablet|Nexus (7|9|10)|SM-T\d|Kindle|Silk/i.test(ua)) return DEVICE.tablet;
  if (/Mobi|iPhone|iPod|Android.+Mobile|Windows Phone/i.test(ua)) return DEVICE.phone;
  if (/Android/i.test(ua)) return DEVICE.tablet;
  return DEVICE.pc;
}

export interface Offer {
  placement: 'search' | 'question';
  slots: number;
  /** The lowest price per thousand impressions a bid may name, in the currency below. */
  floorCpm: number;
  currency: string;
  /** The page's topics. */
  fields: readonly string[];
  /** The page's path (no query, no fragment): what a bidder may know of where the ad shows. */
  path: string;
  country: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Present only for a reader who allows partner sites: their EID and interest topics. */
  partner: { eid: string; crossDevice: boolean; interests: readonly string[] } | null;
  test: boolean;
  /** Graphinity's own host name (from WEB_ORIGIN): the site and the source of its EIDs. */
  site: string;
}

/**
 * The Native 1.2 request: a title and a description, nothing else (text ads, like Graphinity's
 * own). Context 1 is content-centric; placement type 1 is in the feed of content.
 */
const NATIVE_REQUEST = JSON.stringify({
  ver: '1.2',
  context: 1,
  plcmttype: 1,
  assets: [
    { id: 1, required: 1, title: { len: 90 } },
    { id: 2, required: 1, data: { type: 2, len: 140 } },
  ],
});

const categoriesOf = (fields: readonly string[], map: Readonly<Record<string, string>>) => [
  ...new Set(fields.filter(f => !SENSITIVE_FIELDS.has(f)).flatMap(f => (map[f] ? [map[f]] : []))),
];

/** A BidRequest for one page's slots. */
export function buildBidRequest(o: Offer): Record<string, unknown> {
  const cat = categoriesOf(o.fields, CONTENT_CATEGORY);
  const request: Record<string, unknown> = {
    id: randomUUID(),
    imp: Array.from({ length: o.slots }, (_, i) => ({
      id: String(i + 1),
      native: { request: NATIVE_REQUEST, ver: '1.2' },
      tagid: o.placement,
      bidfloor: o.floorCpm,
      bidfloorcur: o.currency,
      secure: 1,
    })),
    site: {
      id: o.site,
      name: 'Graphinity',
      domain: o.site,
      cattax: CATTAX_CONTENT_3_0,
      ...(cat.length ? { cat, pagecat: cat } : {}),
      page: `https://${o.site}${o.path.split(/[?#]/)[0] ?? '/'}`,
      privacypolicy: 1,
      publisher: { id: o.site, name: 'Graphinity', domain: o.site },
    },
    device: {
      devicetype: deviceType(o.userAgent),
      js: 1,
      ...(o.partner ? truncateIp(o.ip) : {}),
    },
    tmax: TMAX_MS,
    at: SECOND_PRICE,
    cur: [o.currency],
    source: { fd: 0, tid: randomUUID() },
    regs: { coppa: 0, ...(o.country ? { gdpr: GDPR.has(o.country) ? 1 : 0 } : {}) },
    ...(o.test ? { test: 1 } : {}),
  };
  if (o.partner) {
    const segments = categoriesOf(o.partner.interests, AUDIENCE_SEGMENT);
    request.user = {
      ...(segments.length
        ? {
            data: [
              { id: o.site, name: o.site, segment: segments.map(id => ({ id })), ext: { segtax: SEGTAX_AUDIENCE_1_1 } },
            ],
          }
        : {}),
      eids: [
        {
          source: o.site,
          inserter: o.site,
          uids: [{ id: o.partner.eid, atype: o.partner.crossDevice ? AGENT.person : AGENT.browser }],
        },
      ],
    };
  }
  return request;
}

export interface PartnerBid {
  impid: string;
  /** Price per thousand impressions, in the request's currency. */
  price: number;
  headline: string;
  body: string;
  url: string;
  domain: string;
  creative: string;
  seat: string;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (x: unknown, max: number) =>
  typeof x === 'string' && x.trim().length > 0 && x.length <= max && !/[\p{Cc}<>]/u.test(x) ? x.trim() : null;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A Native 1.2 response's title, description and link, or null. Markup is text, never HTML. */
function nativeAd(adm: unknown): { headline: string; body: string; url: string } | null {
  if (typeof adm !== 'string' || adm.length > 8_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(adm);
  } catch {
    return null;
  }
  const root = isObject(parsed) && isObject(parsed.native) ? parsed.native : parsed;
  if (!isObject(root) || !Array.isArray(root.assets) || !isObject(root.link)) return null;
  const assets: unknown[] = root.assets;
  const asset = (id: number) => assets.find((a): a is Record<string, unknown> => isObject(a) && a.id === id);
  const title = asset(1);
  const data = asset(2);
  const headline = text(isObject(title?.title) ? title.title.text : undefined, 90);
  const body = text(isObject(data?.data) ? data.data.value : undefined, 140);
  const href = typeof root.link.url === 'string' ? root.link.url : '';
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!headline || !body || url.protocol !== 'https:' || url.username || url.password) return null;
  return { headline, body, url: url.toString() };
}

/**
 * The valid bids in a BidResponse: for one of the request's impressions, at or above its floor,
 * in its currency, with a text ad linking over https to a domain the bid declares. Anything
 * else is dropped, bid by bid.
 */
export function parseBidResponse(request: Record<string, unknown>, response: unknown): PartnerBid[] {
  if (!isObject(response) || response.id !== request.id || !Array.isArray(response.seatbid)) return [];
  const cur: unknown = Array.isArray(request.cur) ? request.cur[0] : undefined;
  if (response.cur !== undefined && response.cur !== cur) return [];
  const imps = new Map((request.imp as Array<{ id: string; bidfloor: number }>).map(i => [i.id, i.bidfloor] as const));
  const bids: PartnerBid[] = [];
  for (const seat of response.seatbid.slice(0, 20)) {
    if (!isObject(seat) || !Array.isArray(seat.bid)) continue;
    const seatName = text(seat.seat, 64) ?? 'unknown';
    for (const b of seat.bid.slice(0, 20)) {
      if (!isObject(b) || typeof b.impid !== 'string') continue;
      const floor = imps.get(b.impid);
      if (floor === undefined || typeof b.price !== 'number' || !Number.isFinite(b.price) || b.price < floor) continue;
      if (b.price <= 0 || b.price > 1_000_000) continue;
      const ad = nativeAd(b.adm);
      const domains = Array.isArray(b.adomain) ? b.adomain.filter((d): d is string => typeof d === 'string') : [];
      if (!ad || domains.length !== 1) continue;
      const domain = (domains[0] ?? '').toLowerCase();
      const host = new URL(ad.url).hostname;
      if (!HOST.test(domain) || (host !== domain && !host.endsWith(`.${domain}`))) continue;
      bids.push({ impid: b.impid, price: b.price, ...ad, domain, creative: text(b.crid, 64) ?? '', seat: seatName });
    }
  }
  return bids;
}
