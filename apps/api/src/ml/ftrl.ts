// FTRL-Proximal logistic regression (McMahan et al. 2013, "Ad Click
// Prediction: a View from the Trenches"): the method behind production ad
// click prediction, learned online one example at a time. Features are
// strings hashed into a fixed number of weights (the hashing trick), so
// new campaigns or topics need no schema; L1 keeps most weights exactly 0,
// so the model stays small. Per coordinate it keeps z and n (the sum of
// squared gradients), and a weight is
//   w = 0 when |z| <= l1, else -(z - sign(z) l1) / ((beta + sqrt(n)) / alpha + l2).
// Deterministic: the same examples in the same order give the same model.
import { createHash } from 'node:crypto';

export interface FtrlParams {
  alpha: number;
  beta: number;
  l1: number;
  l2: number;
  /** log2 of the number of weights. */
  bits: number;
}

export const FTRL_DEFAULTS: FtrlParams = { alpha: 0.2, beta: 1, l1: 1, l2: 1, bits: 20 };

export interface FtrlModel {
  params: FtrlParams;
  z: Float64Array;
  n: Float64Array;
}

/** A feature's coordinate: the first 4 bytes of its SHA-256, masked to `bits`. Stable across runs. */
export function hashFeature(feature: string, bits: number): number {
  return createHash('sha256').update(feature).digest().readUInt32BE(0) & ((1 << bits) - 1);
}

export function createFtrl(params: Partial<FtrlParams> = {}): FtrlModel {
  const p = { ...FTRL_DEFAULTS, ...params };
  if (p.bits < 4 || p.bits > 24) throw new Error('bits must be between 4 and 24');
  return { params: p, z: new Float64Array(1 << p.bits), n: new Float64Array(1 << p.bits) };
}

function weight(m: FtrlModel, i: number): number {
  const z = m.z[i] ?? 0;
  const { l1, l2, alpha, beta } = m.params;
  if (Math.abs(z) <= l1) return 0;
  return -(z - Math.sign(z) * l1) / ((beta + Math.sqrt(m.n[i] ?? 0)) / alpha + l2);
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, x))));

/** The coordinates of an example's features, with a bias that every example has. */
export const coordinates = (features: readonly string[], bits: number): number[] => [
  ...new Set(['bias', ...features].map(f => hashFeature(f, bits))),
];

export function predictCoordinates(m: FtrlModel, idx: readonly number[]): number {
  let s = 0;
  for (const i of idx) s += weight(m, i);
  return sigmoid(s);
}

export const predict = (m: FtrlModel, features: readonly string[]) =>
  predictCoordinates(m, coordinates(features, m.params.bits));

/** One online step: predict, then move each touched coordinate. Returns the prediction made before learning. */
export function learn(m: FtrlModel, features: readonly string[], clicked: boolean): number {
  const idx = coordinates(features, m.params.bits);
  const p = predictCoordinates(m, idx);
  const g = p - (clicked ? 1 : 0);
  for (const i of idx) {
    const n = m.n[i] ?? 0;
    const sigma = (Math.sqrt(n + g * g) - Math.sqrt(n)) / m.params.alpha;
    m.z[i] = (m.z[i] ?? 0) + g - sigma * weight(m, i);
    m.n[i] = n + g * g;
  }
  return p;
}

/** Weights that aren't 0, as [coordinate, weight] pairs: what serving needs. */
export function sparseWeights(m: FtrlModel): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < m.z.length; i++) {
    const w = weight(m, i);
    if (w !== 0) out.push([i, w]);
  }
  return out;
}

/** A serving model: the non-zero weights only (training state isn't kept). */
export interface FtrlServing {
  bits: number;
  weights: Map<number, number>;
}

export function servingOf(m: FtrlModel): FtrlServing {
  return { bits: m.params.bits, weights: new Map(sparseWeights(m)) };
}

export function predictServing(s: FtrlServing, features: readonly string[]): number {
  let sum = 0;
  for (const i of coordinates(features, s.bits)) sum += s.weights.get(i) ?? 0;
  return sigmoid(sum);
}

const MAGIC = 'GFT1';

export function serializeServing(s: FtrlServing): Buffer {
  const entries = [...s.weights].sort((a, b) => a[0] - b[0]);
  const out = Buffer.alloc(4 + 1 + 4 + entries.length * 12);
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt8(s.bits, 4);
  out.writeUInt32LE(entries.length, 5);
  entries.forEach(([i, w], k) => {
    out.writeUInt32LE(i, 9 + k * 12);
    out.writeDoubleLE(w, 13 + k * 12);
  });
  return out;
}

export function deserializeServing(buf: Buffer): FtrlServing {
  if (buf.length < 9 || buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('not an FTRL model');
  const bits = buf.readUInt8(4);
  const count = buf.readUInt32LE(5);
  if (bits < 4 || bits > 24 || buf.length !== 9 + count * 12) throw new Error('damaged FTRL model');
  const weights = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    const i = buf.readUInt32LE(9 + k * 12);
    const w = buf.readDoubleLE(13 + k * 12);
    if (i >= 1 << bits || !Number.isFinite(w)) throw new Error('damaged FTRL model');
    weights.set(i, w);
  }
  return { bits, weights };
}

/** Mean log loss of predictions against outcomes (lower is better), clipped away from 0 and 1. */
export function logLoss(predictions: readonly number[], clicks: readonly boolean[]): number {
  let s = 0;
  predictions.forEach((p, i) => {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
    s += clicks[i] ? -Math.log(q) : -Math.log(1 - q);
  });
  return predictions.length ? s / predictions.length : 0;
}
