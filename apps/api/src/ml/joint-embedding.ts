// Joint text-image embedding (ADR 0037): two linear maps, one for an image's features and one for a text's vector,
// trained so a matching pair lands close and every other pair in the batch far apart: the symmetric InfoNCE loss CLIP
// uses (Radford et al. 2021), with fixed encoders on each side. Written by hand in typed arrays: no downloaded weights.
// Graphinity takes no images (ADR 0037 says why), so this is the engine only: it has no caller and no data.
import { seededRandom } from './linalg.ts';
import { at } from './num.ts';

export interface JointEmbedding {
  dims: number;
  imageInputs: number;
  textInputs: number;
  /** dims × imageInputs, then dims × textInputs */
  image: Float64Array;
  text: Float64Array;
}

export interface JointOptions {
  dims?: number;
  epochs?: number;
  batch?: number;
  rate?: number;
  temperature?: number;
  seed?: number;
}

function project(w: Float64Array, x: ArrayLike<number>, dims: number, inputs: number): Float64Array {
  const out = new Float64Array(dims);
  for (let d = 0; d < dims; d++) {
    let s = 0;
    for (let i = 0; i < inputs; i++) s += at(w, d * inputs + i) * at(x, i);
    out[d] = s;
  }
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += at(out, d) ** 2;
  const scale = norm ? 1 / Math.sqrt(norm) : 1;
  for (let d = 0; d < dims; d++) out[d] = at(out, d) * scale;
  return out;
}

export const embedImage = (m: JointEmbedding, x: ArrayLike<number>) => project(m.image, x, m.dims, m.imageInputs);
export const embedText = (m: JointEmbedding, x: ArrayLike<number>) => project(m.text, x, m.dims, m.textInputs);

const dot = (a: Float64Array, b: Float64Array) => a.reduce((s, v, i) => s + v * at(b, i), 0);

export function trainJointEmbedding(
  pairs: ReadonlyArray<{ image: ArrayLike<number>; text: ArrayLike<number> }>,
  options: JointOptions = {},
): JointEmbedding {
  const { dims = 16, epochs = 30, batch = 32, rate = 0.05, temperature = 0.1 } = options;
  const random = seededRandom(options.seed ?? 1);
  const first = pairs[0];
  const imageInputs = first ? first.image.length : 0;
  const textInputs = first ? first.text.length : 0;
  const init = (n: number) => new Float64Array(n).map(() => (random() - 0.5) * 0.2);
  const m: JointEmbedding = {
    dims,
    imageInputs,
    textInputs,
    image: init(dims * imageInputs),
    text: init(dims * textInputs),
  };
  const order = Array.from(pairs.keys());
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [at(order, j), at(order, i)];
    }
    for (let start = 0; start + 1 < order.length; start += batch) {
      const ids = order.slice(start, start + batch);
      const imgs = ids.map(i => embedImage(m, pairs[i]?.image ?? []));
      const txts = ids.map(i => embedText(m, pairs[i]?.text ?? []));
      const n = ids.length;
      // Similarity logits and both softmaxes (image→text by row, text→image by column).
      const logits = imgs.map(a => txts.map(b => dot(a, b) / temperature));
      const softmax = (row: number[]) => {
        const top = Math.max(...row);
        const e = row.map(v => Math.exp(v - top));
        const z = e.reduce((s, v) => s + v, 0);
        return e.map(v => v / z);
      };
      const byRow = logits.map(softmax);
      const byCol = Array.from({ length: n }, (_, c) => softmax(logits.map(r => r[c] ?? 0)));
      // d(loss)/d(logit[r][c]) for the symmetric loss, averaged over the batch.
      const g = (r: number, c: number) =>
        ((byRow[r]?.[c] ?? 0) - (r === c ? 1 : 0) + (byCol[c]?.[r] ?? 0) - (r === c ? 1 : 0)) / (2 * n);
      // Gradient through the (normalised) embeddings, approximated at fixed norm: a step on the raw projection.
      for (let r = 0; r < n; r++) {
        const xi = pairs[ids[r] ?? 0]?.image ?? [];
        const xt = pairs[ids[r] ?? 0]?.text ?? [];
        const towardImg = new Float64Array(dims);
        const towardTxt = new Float64Array(dims);
        for (let c = 0; c < n; c++) {
          const gr = g(r, c) / temperature;
          const gc = g(c, r) / temperature;
          const tc = txts[c] ?? new Float64Array(dims);
          const ic = imgs[c] ?? new Float64Array(dims);
          for (let d = 0; d < dims; d++) {
            towardImg[d] = at(towardImg, d) + gr * at(tc, d);
            towardTxt[d] = at(towardTxt, d) + gc * at(ic, d);
          }
        }
        for (let d = 0; d < dims; d++) {
          for (let i = 0; i < imageInputs; i++)
            m.image[d * imageInputs + i] = at(m.image, d * imageInputs + i) - rate * at(towardImg, d) * at(xi, i);
          for (let i = 0; i < textInputs; i++)
            m.text[d * textInputs + i] = at(m.text, d * textInputs + i) - rate * at(towardTxt, d) * at(xt, i);
        }
      }
    }
  }
  return m;
}

/** Share of texts whose own image is the nearest of all images: retrieval recall@1. */
export function recallAt1(
  m: JointEmbedding,
  pairs: ReadonlyArray<{ image: ArrayLike<number>; text: ArrayLike<number> }>,
): number {
  if (!pairs.length) return 0;
  const imgs = pairs.map(p => embedImage(m, p.image));
  let hits = 0;
  pairs.forEach((p, i) => {
    const t = embedText(m, p.text);
    let best = -1;
    let bestScore = -Infinity;
    imgs.forEach((im, j) => {
      const s = dot(im, t);
      if (s > bestScore) [best, bestScore] = [j, s];
    });
    if (best === i) hits += 1;
  });
  return hits / pairs.length;
}
