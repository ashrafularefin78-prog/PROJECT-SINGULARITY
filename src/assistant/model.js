/**
 * SINGU intent model - a trained network over hashed character n-grams.
 *
 * What it is: a two-layer classifier (averaged embedding + softmax) in the
 * fastText-supervised family. A brief is turned into word and character
 * n-gram features, those features are hashed into an embedding table, the
 * vectors are averaged, and the hidden layer scores the 15 catalogue
 * patterns plus an explicit "none of these" class. It has real weights, so it
 * has a real parameter count: `parameterCount` derives it from the shapes in
 * the file it parsed rather than from a constant.
 *
 * What it is not: a language model. It does not generate text, has no
 * vocabulary to sample from, and never writes C. The brief is its only input
 * and a pattern id is its only output; the catalogue in singu.js remains the
 * thing that emits a program that compiles.
 *
 * Why it exists: `scoreRecipe` matches literal keywords, so a brief that names
 * a pattern with a typo or a synonym the list does not carry falls through to
 * the low-level starter. Character n-grams generalise where a keyword list
 * cannot, which is measured in docs/reports/singu-intent.json rather than
 * asserted here.
 *
 * The module is pure: no DOM, no network, no storage. Bytes come in through
 * `parse` and predictions go out through `classify`, so the same code runs in
 * Node and in the browser, and a test can feed it any file it likes.
 */

export const MODEL_MAGIC = 'SGIM';
export const MODEL_VERSION = 1;
export const NONE_LABEL = '__none__';

/**
 * The floor a top probability has to clear for the model to be believed. One
 * definition, used by the panel, by the loader and by the training report, so
 * the accuracy published in docs/reports/singu-intent.json is measured with the
 * same cutoff the shipped page applies.
 */
export const INTENT_THRESHOLD = 0.5;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const fnv1a = (text) => {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
};

export const normaliseBrief = (text) => String(text == null ? '' : text)
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Feature ids for one brief: the whole word, plus its character 3- and
 * 4-grams wrapped in spaces so prefixes and suffixes get their own features.
 * A set, so a repeated word contributes once.
 */
export function featurize(text, dims) {
  if ((dims & (dims - 1)) !== 0) throw new Error(`dims must be a power of two, got ${dims}`);
  const mask = dims - 1;
  const words = normaliseBrief(text).split(' ').filter((word) => word.length > 1);
  const ids = new Set();
  for (const word of words) {
    ids.add(fnv1a(`w:${word}`) & mask);
    const padded = ` ${word} `;
    for (const n of [3, 4]) {
      for (let i = 0; i + n <= padded.length; i += 1) ids.add(fnv1a(`c${n}:${padded.slice(i, i + n)}`) & mask);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

const align4 = (n) => (n + 3) & ~3;

/**
 * Byte offsets of every section, derived from the shapes alone. The writer in
 * tools/train-singu-model.js calls this same function, so the format has one
 * definition rather than two that can drift apart. The padding exists because
 * a Float32Array view refuses a start offset that is not a multiple of four,
 * and a JSON header of arbitrary length would otherwise put every section
 * after it out of step.
 */
export function layoutOf({ dims, hidden, classes, headerLength }) {
  const embeddingAt = align4(24 + headerLength);
  const rowScalesAt = align4(embeddingAt + dims * hidden);
  const outputAt = align4(rowScalesAt + 4 * dims);
  const colScalesAt = align4(outputAt + hidden * classes);
  const biasAt = align4(colScalesAt + 4 * classes);
  return { embeddingAt, rowScalesAt, outputAt, colScalesAt, biasAt, bytes: biasAt + 4 * classes };
}

/** Read one artifact. Every length is checked against the declared shapes. */
export function parse(bytes) {
  // A Buffer handed over from node:fs can sit at a non-zero offset inside the
  // pool that backs it, and a Float32Array view over such a buffer is illegal.
  // Copying once here keeps every caller from having to think about it.
  if (bytes.byteOffset % 4 !== 0) bytes = new Uint8Array(bytes.slice(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 24) throw new Error(`intent artifact is truncated (${bytes.byteLength} bytes)`);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MODEL_MAGIC) throw new Error(`intent artifact has magic "${magic}", expected "${MODEL_MAGIC}"`);
  const version = view.getUint32(4, true);
  if (version !== MODEL_VERSION) throw new Error(`intent artifact version ${version} is not supported`);
  const dims = view.getUint32(8, true);
  const hidden = view.getUint32(12, true);
  const classes = view.getUint32(16, true);
  const headerLength = view.getUint32(20, true);
  if (!dims || !hidden || !classes || (dims & (dims - 1)) !== 0) {
    throw new Error(`intent artifact declares an unusable shape (dims ${dims}, hidden ${hidden}, classes ${classes})`);
  }
  const expected = layoutOf({ dims, hidden, classes, headerLength });
  if (24 + headerLength > bytes.byteLength) {
    throw new Error(`intent artifact declares a ${headerLength}-byte header in a ${bytes.byteLength}-byte file`);
  }
  if (bytes.byteLength !== expected.bytes) {
    throw new Error(`intent artifact is ${bytes.byteLength} bytes, its own header says ${expected.bytes}`);
  }
  let meta;
  try {
    meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(24, 24 + headerLength)));
  } catch (error) {
    throw new Error(`intent artifact header is not JSON: ${error.message}`);
  }
  if (!Array.isArray(meta.labels) || meta.labels.length !== classes) {
    throw new Error(`intent artifact header lists ${meta.labels ? meta.labels.length : 0} labels for ${classes} classes`);
  }
  const at = (offset, length, Ctor) => new Ctor(bytes.buffer, bytes.byteOffset + offset, length);
  return {
    dims,
    hidden,
    classes,
    labels: meta.labels,
    meta,
    bytes: bytes.byteLength,
    E: at(expected.embeddingAt, dims * hidden, Int8Array),
    rowScales: at(expected.rowScalesAt, dims, Float32Array),
    W: at(expected.outputAt, hidden * classes, Int8Array),
    colScales: at(expected.colScalesAt, classes, Float32Array),
    bias: at(expected.biasAt, classes, Float32Array),
  };
}

/** The averaged embedding of one brief: hidden floats. */
function hiddenOf(model, ids) {
  const { hidden, E, rowScales } = model;
  const out = new Float32Array(hidden);
  if (!ids.length) return out;
  let used = 0;
  for (const id of ids) {
    const scale = rowScales[id];
    if (scale === 0) continue;
    used += 1;
    const base = id * hidden;
    for (let j = 0; j < hidden; j += 1) out[j] += scale * E[base + j];
  }
  if (!used) return out;
  for (let j = 0; j < hidden; j += 1) out[j] /= used;
  return out;
}

export function logitsOf(model, ids) {
  const { hidden, classes, W, colScales, bias } = model;
  const h = hiddenOf(model, ids);
  const logits = new Float64Array(classes);
  for (let c = 0; c < classes; c += 1) logits[c] = bias[c];
  for (let j = 0; j < hidden; j += 1) {
    const hv = h[j];
    if (hv === 0) continue;
    const base = j * classes;
    for (let c = 0; c < classes; c += 1) logits[c] += hv * colScales[c] * W[base + c];
  }
  return logits;
}

export function softmax(logits) {
  let max = -Infinity;
  for (const value of logits) if (value > max) max = value;
  const exps = new Float64Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i += 1) {
    exps[i] = Math.exp(logits[i] - max);
    sum += exps[i];
  }
  for (let i = 0; i < exps.length; i += 1) exps[i] /= sum;
  return exps;
}

/**
 * Rank the classes for one brief. `threshold` is the floor on the top
 * probability: below it the answer is "nothing in the catalogue fits", which
 * is the same outcome as the explicit none class and is reported as such.
 */
export function classify(model, text, { threshold = INTENT_THRESHOLD, top = 3 } = {}) {
  const probs = softmax(logitsOf(model, featurize(text, model.dims)));
  const ranked = [...probs]
    .map((p, index) => ({ id: model.labels[index], p, index }))
    .sort((a, b) => b.p - a.p || a.index - b.index);
  const top1 = ranked[0];
  return {
    ok: top1.id !== NONE_LABEL && top1.p >= threshold,
    id: top1.id,
    p: top1.p,
    ranked: ranked.slice(0, top),
  };
}

/** Counted from the parsed shapes, never typed. */
export function parameterCount(model) {
  const embedding = model.dims * model.hidden;
  const output = model.hidden * model.classes;
  const bias = model.classes;
  return { embedding, output, bias, total: embedding + output + bias };
}

/**
 * How much of the embedding table the training corpus actually touched. A row
 * that is still all zero cannot contribute to any prediction, so this is
 * published next to the parameter count rather than hidden behind it.
 */
export function trainedRows(model) {
  let rows = 0;
  for (let i = 0; i < model.dims; i += 1) if (model.rowScales[i] !== 0) rows += 1;
  return { rows, of: model.dims, share: rows / model.dims };
}
