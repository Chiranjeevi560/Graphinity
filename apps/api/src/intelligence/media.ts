// Images and receipts (master charter §10.4). dHash (Krawetz 2013) and pHash (a 32×32
// DCT) make 64-bit fingerprints that survive resizing and recompression; two images
// within Hamming distance 6 are treated as the same. Input is grayscale pixels, so no
// image library is needed here. Receipt text comes from OCR on the person's own
// device; this redacts it before anything is stored, and strips EXIF from JPEGs.
import { at } from '../ml/num.ts';

export interface Gray {
  width: number;
  height: number;
  pixels: Uint8Array | Float64Array;
}

function resize(g: Gray, w: number, h: number): Float64Array {
  // Exact area averaging: each output cell weighs source pixels by how much of them it covers, so
  // the fingerprint barely depends on the source's size (whole-pixel boxes moved pHash by 8 bits).
  const out = new Float64Array(w * h);
  const sx = g.width / w;
  const sy = g.height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const y0 = y * sy;
      const y1 = (y + 1) * sy;
      let s = 0;
      let area = 0;
      for (let j = Math.floor(y0); j < Math.min(g.height, Math.ceil(y1)); j++) {
        const hy = Math.min(j + 1, y1) - Math.max(j, y0);
        for (let i = Math.floor(x0); i < Math.min(g.width, Math.ceil(x1)); i++) {
          const a = hy * (Math.min(i + 1, x1) - Math.max(i, x0));
          s += a * at(g.pixels, j * g.width + i);
          area += a;
        }
      }
      out[y * w + x] = area > 0 ? s / area : 0;
    }
  return out;
}

export function dHash(g: Gray): bigint {
  const s = resize(g, 9, 8);
  let h = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) h = (h << 1n) | (at(s, y * 9 + x) > at(s, y * 9 + x + 1) ? 1n : 0n);
  return h;
}

export function pHash(g: Gray): bigint {
  const n = 32;
  const s = resize(g, n, n);
  const low: number[] = [];
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let c = 0;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          c +=
            at(s, y * n + x) *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * n));
      low.push(c);
    }
  // Median of all but the DC term, which only measures overall brightness.
  const sorted = low.slice(1).sort((a, b) => a - b);
  const median = at(sorted, Math.floor(sorted.length / 2));
  let h = 0n;
  for (const c of low) h = (h << 1n) | (c > median ? 1n : 0n);
  return h;
}

export function hamming(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x > 0n) {
    x &= x - 1n;
    n += 1;
  }
  return n;
}

export const DUPLICATE_DISTANCE = 6;
export const isDuplicate = (a: bigint, b: bigint) => hamming(a, b) < DUPLICATE_DISTANCE;

/** Multi-index: by the pigeonhole principle, hashes within distance < 8 share one 8-bit band. */
export class HashIndex {
  private readonly bands = Array.from({ length: 8 }, () => new Map<number, bigint[]>());
  add(h: bigint): void {
    this.bands.forEach((band, i) => {
      const k = Number((h >> BigInt(i * 8)) & 0xffn);
      band.set(k, [...(band.get(k) ?? []), h]);
    });
  }
  /** A near-duplicate already indexed, or null. */
  find(h: bigint): bigint | null {
    for (let i = 0; i < 8; i++) {
      const k = Number((h >> BigInt(i * 8)) & 0xffn);
      for (const other of this.bands[i]?.get(k) ?? []) if (isDuplicate(h, other)) return other;
    }
    return null;
  }
}

export interface ReceiptSignals {
  date: string | null;
  tariffCode: string | null;
  dutyTotal: number | null;
  redacted: string;
}

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[number]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id]'],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[id]'],
  [/(?:\+?\d{1,3}[ -]?)?\b\d{10}\b/g, '[phone]'],
  [/\b(name|customer|consignee|importer|passenger|account|a\/c|address)\b\s*[:#-]?\s*[^\n]*/gi, '$1: [removed]'],
];

/** Signals only, from text that keeps none of the person's identifiers. Redaction goes first. */
export function verifyReceiptText(text: string): ReceiptSignals {
  let redacted = text.slice(0, 20_000);
  for (const [pattern, swap] of REDACTIONS) redacted = redacted.replace(pattern, swap);
  const date = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/.exec(redacted)?.[1] ?? null;
  const tariffCode = /\b(?:hs|hsn|cth|tariff)(?:\s*code)?\s*[:#-]?\s*(\d{4,10})\b/i.exec(redacted)?.[1] ?? null;
  const duty =
    /\b(?:total\s+)?duty(?:\s+(?:total|paid|amount))?\s*[:#-]?\s*(?:₹|rs\.?|inr|\$)?\s*([\d,]+(?:\.\d+)?)/i.exec(
      redacted,
    )?.[1];
  return { date, tariffCode, dutyTotal: duty ? Number(duty.replace(/,/g, '')) : null, redacted };
}

/** A JPEG with every APP1 (EXIF, XMP, so GPS) segment removed; anything else unchanged. */
export function stripExif(jpeg: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const parts: Buffer[] = [jpeg.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = at(jpeg, i + 1);
    if (marker === 0xda) break;
    const size = jpeg.readUInt16BE(i + 2);
    if (marker !== 0xe1) parts.push(jpeg.subarray(i, i + 2 + size));
    i += 2 + size;
  }
  parts.push(jpeg.subarray(i));
  return Buffer.concat(parts);
}
