// Bounded-memory analytics (master charter §9). Exact DISTINCT and percentiles
// scan every raw row; these answer from a fixed size and merge across days:
// - HyperLogLog (Flajolet 2007; Heule et al. 2013): uniques, about 1.04/√m error;
// - Count-Min (Cormode & Muthukrishnan 2005): frequencies, only ever overestimates;
// - t-digest (Dunning 2019): quantiles, most accurate at the tails.
// Each serializes to bytes, for storing in a rollup row.
import { murmur3 } from '../experiments/murmur.ts';
import { at } from '../ml/num.ts';

const HLL_P = 12;
const HLL_M = 1 << HLL_P;

export class HyperLogLog {
  readonly registers: Uint8Array;
  constructor(registers?: Uint8Array) {
    this.registers = registers ?? new Uint8Array(HLL_M);
  }
  add(value: string): void {
    const h1 = murmur3(value, 0x9747b28c);
    const h2 = murmur3(value, 0x1b873593);
    const index = h1 >>> (32 - HLL_P);
    // Rank from the low 20 bits of h1, then a second hash: 52 usable bits avoid 32-bit saturation.
    const rest = h1 & ((1 << (32 - HLL_P)) - 1);
    const rank = rest !== 0 ? Math.clz32(rest) - HLL_P + 1 : 32 - HLL_P + Math.clz32(h2) + 1;
    if (rank > at(this.registers, index)) this.registers[index] = rank;
  }
  merge(other: HyperLogLog): void {
    for (let i = 0; i < HLL_M; i++) this.registers[i] = Math.max(at(this.registers, i), at(other.registers, i));
  }
  count(): number {
    let sum = 0;
    let zeros = 0;
    for (const r of this.registers) {
      sum += 2 ** -r;
      if (r === 0) zeros += 1;
    }
    const alpha = 0.7213 / (1 + 1.079 / HLL_M);
    const raw = (alpha * HLL_M * HLL_M) / sum;
    // Small range: linear counting is more accurate (HLL++ threshold for p = 12).
    if (zeros > 0) {
      const linear = HLL_M * Math.log(HLL_M / zeros);
      if (linear <= 3000) return Math.round(linear);
    }
    return Math.round(raw);
  }
  toBytes(): Buffer {
    return Buffer.from(this.registers);
  }
  static fromBytes(b: Uint8Array): HyperLogLog {
    if (b.length !== HLL_M) throw new RangeError('not a HyperLogLog');
    return new HyperLogLog(Uint8Array.from(b));
  }
}

export class CountMinSketch {
  readonly table: Uint32Array;
  readonly width: number;
  readonly depth: number;
  constructor(width = 2048, depth = 5, table?: Uint32Array) {
    this.width = width;
    this.depth = depth;
    this.table = table ?? new Uint32Array(width * depth);
  }
  private slot(value: string, d: number): number {
    return d * this.width + (murmur3(value, d * 0x5bd1e995) % this.width);
  }
  add(value: string, by = 1): void {
    for (let d = 0; d < this.depth; d++) {
      const s = this.slot(value, d);
      this.table[s] = at(this.table, s) + by;
    }
  }
  estimate(value: string): number {
    let min = Infinity;
    for (let d = 0; d < this.depth; d++) min = Math.min(min, at(this.table, this.slot(value, d)));
    return min;
  }
  merge(other: CountMinSketch): void {
    if (other.width !== this.width || other.depth !== this.depth) throw new RangeError('different shapes');
    for (let i = 0; i < this.table.length; i++) this.table[i] = at(this.table, i) + at(other.table, i);
  }
  toBytes(): Buffer {
    const b = Buffer.alloc(8 + this.table.length * 4);
    b.writeUInt32LE(this.width, 0);
    b.writeUInt32LE(this.depth, 4);
    this.table.forEach((v, i) => b.writeUInt32LE(v, 8 + i * 4));
    return b;
  }
  static fromBytes(b: Buffer): CountMinSketch {
    const width = b.readUInt32LE(0);
    const depth = b.readUInt32LE(4);
    if (b.length !== 8 + width * depth * 4) throw new RangeError('not a Count-Min sketch');
    const table = new Uint32Array(width * depth);
    for (let i = 0; i < table.length; i++) table[i] = b.readUInt32LE(8 + i * 4);
    return new CountMinSketch(width, depth, table);
  }
}

export class TDigest {
  private means: number[] = [];
  private weights: number[] = [];
  private buffer: number[] = [];
  private readonly compression: number;
  constructor(compression = 100) {
    this.compression = compression;
  }
  add(value: number): void {
    this.buffer.push(value);
    if (this.buffer.length >= this.compression * 5) this.compress();
  }
  get total(): number {
    this.compress();
    return this.weights.reduce((a, b) => a + b, 0);
  }
  /** Merging digests: the k1 scale function keeps centroids small near 0 and 1. */
  private compress(): void {
    if (this.buffer.length === 0) return;
    const items = [
      ...this.means.map((m, i) => ({ m, w: at(this.weights, i) })),
      ...this.buffer.map(m => ({ m, w: 1 })),
    ].sort((a, b) => a.m - b.m);
    this.buffer = [];
    this.absorb(items);
  }
  private absorb(items: ReadonlyArray<{ m: number; w: number }>): void {
    const total = items.reduce((a, c) => a + c.w, 0);
    const k = (q: number) => (this.compression / (2 * Math.PI)) * Math.asin(2 * q - 1);
    const means: number[] = [];
    const weights: number[] = [];
    let seen = 0;
    let cm = 0;
    let cw = 0;
    let limit = 0;
    for (const { m, w } of items) {
      if (cw === 0) {
        cm = m;
        cw = w;
        limit = k(seen / total) + 1;
        continue;
      }
      if (k(Math.min(1, (seen + cw + w) / total)) <= limit) {
        cm += ((m - cm) * w) / (cw + w);
        cw += w;
      } else {
        means.push(cm);
        weights.push(cw);
        seen += cw;
        cm = m;
        cw = w;
        limit = k(seen / total) + 1;
      }
    }
    if (cw > 0) {
      means.push(cm);
      weights.push(cw);
    }
    this.means = means;
    this.weights = weights;
  }
  merge(other: TDigest): void {
    this.compress();
    other.compress();
    this.absorb(
      [
        ...this.means.map((m, i) => ({ m, w: at(this.weights, i) })),
        ...other.means.map((m, i) => ({ m, w: at(other.weights, i) })),
      ].sort((a, b) => a.m - b.m),
    );
  }
  quantile(q: number): number {
    this.compress();
    const n = this.means.length;
    if (n === 0) return NaN;
    const target = q * this.weights.reduce((a, b) => a + b, 0);
    let seen = 0;
    for (let i = 0; i < n; i++) {
      const w = at(this.weights, i);
      const centre = seen + w / 2;
      if (target < centre) {
        if (i === 0) return this.means[0] ?? NaN;
        const before = seen - at(this.weights, i - 1) / 2;
        const t = (target - before) / (centre - before);
        return at(this.means, i - 1) + t * (at(this.means, i) - at(this.means, i - 1));
      }
      seen += w;
    }
    return this.means[n - 1] ?? NaN;
  }
  toBytes(): Buffer {
    this.compress();
    const b = Buffer.alloc(this.means.length * 16);
    this.means.forEach((m, i) => {
      b.writeDoubleLE(m, i * 16);
      b.writeDoubleLE(at(this.weights, i), i * 16 + 8);
    });
    return b;
  }
  static fromBytes(b: Buffer, compression = 100): TDigest {
    if (b.length % 16 !== 0) throw new RangeError('not a t-digest');
    const d = new TDigest(compression);
    for (let i = 0; i < b.length; i += 16) {
      d.means.push(b.readDoubleLE(i));
      d.weights.push(b.readDoubleLE(i + 8));
    }
    return d;
  }
}
