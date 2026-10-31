// MurmurHash3 x86 32-bit (Austin Appleby, public domain): the assignment hash.
// Fast, evenly spread, deterministic across restarts and machines. Not secure,
// so a layer's secret salt is what keeps assignments from being predicted.

const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

export function murmur3(text: string, seed = 0): number {
  const data = Buffer.from(text, 'utf8');
  let h = seed | 0;
  const blocks = data.length & ~3;
  for (let i = 0; i < blocks; i += 4) {
    let k = data.readInt32LE(i);
    k = Math.imul(k, C1);
    k = rotl(k, 15);
    k = Math.imul(k, C2);
    h ^= k;
    h = rotl(h, 13);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const left = data.length & 3;
  if (left === 3) k ^= (data[blocks + 2] ?? 0) << 16;
  if (left >= 2) k ^= (data[blocks + 1] ?? 0) << 8;
  if (left >= 1) {
    k ^= data[blocks] ?? 0;
    k = Math.imul(k, C1);
    k = rotl(k, 15);
    k = Math.imul(k, C2);
    h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
