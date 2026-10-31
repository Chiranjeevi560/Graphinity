// Finding products in text (master charter §8). Candidates come from a small
// brand dictionary plus a model-number pattern, normalized to one canonical key, so
// "MacBook Pro M4" and "macbook-pro m4" are one product. Near-spellings merge by
// Jaro-Winkler above 0.92, blocked on the brand, so comparisons stay near-linear.

const BRANDS = new Set(
  'apple samsung google oneplus xiaomi realme sony lg dell hp lenovo asus acer microsoft nokia oppo vivo motorola rolex omega tudor seiko casio titan fossil tissot toyota honda hyundai tata maruti mahindra suzuki bmw audi mercedes nike adidas puma macbook iphone ipad galaxy pixel thinkpad'.split(
    ' ',
  ),
);
const MODEL = /^(?=.*\d)[a-z0-9-]{2,12}$/;
const STOP = new Set('the a an of for to in on with and or from vs under over best is are how what'.split(' '));

export function normalizeProductText(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

export interface ProductMention {
  key: string;
  brand: string;
  label: string;
}

/** Each brand word, with the following words up to a model number or stop word. */
export function extractProducts(text: string): ProductMention[] {
  const words = normalizeProductText(text);
  const found = new Map<string, ProductMention>();
  words.forEach((w, i) => {
    if (!BRANDS.has(w)) return;
    const parts = [w];
    for (let k = i + 1; k < Math.min(words.length, i + 4); k++) {
      const next = words[k] ?? '';
      if (STOP.has(next) || BRANDS.has(next)) break;
      parts.push(next);
      if (MODEL.test(next)) break;
    }
    if (parts.length < 2 && !['macbook', 'iphone', 'ipad', 'thinkpad'].includes(w)) return;
    const key = parts.join('-');
    found.set(key, { key, brand: w, label: parts.join(' ') });
  });
  return [...found.values()];
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++)
      if (!bm[j] && a[i] === b[j]) {
        am[i] = true;
        bm[j] = true;
        m += 1;
        break;
      }
  if (m === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k += 1;
    if (a[i] !== b[k]) t += 1;
    k += 1;
  }
  const j = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let l = 0;
  while (l < 4 && a[l] !== undefined && a[l] === b[l]) l += 1;
  return j + l * 0.1 * (1 - j);
}

/** Maps each key to its canonical key (the most mentioned of its near-spellings). */
export function resolveEntities(mentions: ReadonlyArray<{ key: string; brand: string; count: number }>) {
  const canonical = new Map<string, string>();
  const byBrand = new Map<string, Array<{ key: string; count: number }>>();
  for (const m of [...mentions].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))) {
    const peers = byBrand.get(m.brand) ?? [];
    const match = peers.find(p => jaroWinkler(p.key, m.key) >= 0.92 && digits(p.key) === digits(m.key));
    canonical.set(m.key, match?.key ?? m.key);
    if (!match) peers.push(m);
    byBrand.set(m.brand, peers);
  }
  return canonical;
}

// "pixel 8" and "pixel 9" read alike and are different products.
const digits = (s: string) => s.replace(/\D/g, '');
