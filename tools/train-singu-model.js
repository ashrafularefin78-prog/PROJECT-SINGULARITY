/**
 * Train the SINGU intent model and write its artifact.
 *
 *   node tools/train-singu-model.js --sweep          # the run that produces the shipped artifact
 *   node tools/train-singu-model.js --sweep --json   # same search, print it, write nothing
 *   node tools/train-singu-model.js --dims 4096 --hidden 32 --epochs 160 --json
 *                                                    # one configuration, for probing
 *   node tools/train-singu-model.js --fingerprint    # the catalogue hash, write nothing
 *
 * Everything the shipped artifact claims comes from this run: the parameter
 * count is computed from the shapes written to the file, the accuracy is
 * measured on held-out briefs against the quantized bytes that actually ship,
 * and the baseline beside it is the real keyword matcher answering the same
 * briefs. The catalogue is the only source of supervision, so the report
 * fingerprints it: change a keyword list without retraining and
 * tools/check-docs.js fails rather than letting a stale artifact keep its
 * published score.
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECIPES, generate } from '../src/assistant/singu.js';
import {
  MODEL_MAGIC, MODEL_VERSION, NONE_LABEL, INTENT_THRESHOLD, featurize, layoutOf, parse, classify, parameterCount, trainedRows,
} from '../src/assistant/model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const asJson = flag('--json');
const epochs = Number(valueOf('--epochs') || 160);
const seed = Number(valueOf('--seed') || 7);
const size = { dims: Number(valueOf('--dims') || 4096), hidden: Number(valueOf('--hidden') || 32) };
const outPath = resolve(root, valueOf('--out') || 'assets/models/singu-intent.bin');
const reportPath = resolve(root, valueOf('--report') || 'docs/reports/singu-intent.json');
const SWEEP_SIZES = [
  { dims: 1024, hidden: 16 },
  { dims: 2048, hidden: 16 },
  { dims: 2048, hidden: 32 },
  { dims: 4096, hidden: 32 },
  { dims: 4096, hidden: 64 },
  { dims: 8192, hidden: 32 },
  { dims: 8192, hidden: 64 },
  { dims: 16384, hidden: 128 },
  { dims: 16384, hidden: 256 },
];

const prng = (start) => {
  let a = start >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ------------------------------------------------------------------ corpus

const TRAIN_TEMPLATES = [
  (k) => k,
  (k) => `a ${k}`,
  (k) => `write a c program with ${k}`,
  (k) => `i need ${k}`,
  (k) => `give me a ${k}`,
  (k) => `build ${k} in c`,
  (k) => `implement ${k}`,
  (k) => `show me a ${k}`,
  (k) => `how do i write ${k}`,
  (k) => `code up a ${k} for me`,
  (k) => `c implementation of ${k}`,
  (k) => `can you write ${k}`,
];

// Held-out briefs use templates the model never saw, so phrasing is not the
// thing being memorised.
const EVAL_TEMPLATES = [
  (k) => `please produce ${k}`,
  (k) => `something like ${k}`,
  (k) => `i want to make ${k}`,
  (k) => `write ${k} please`,
  (k) => `a working ${k} in c`,
  (k) => `set up ${k} for me`,
  (k) => `do a ${k}`,
  (k) => `${k} in c please`,
  (k) => `id like ${k}`,
  (k) => `help me with a ${k}`,
];

const NONE_TRAIN = [
  'write a poem about the autumn rain',
  'what is the capital of france',
  'translate this sentence into spanish',
  'summarise the fall of rome',
  'a recipe for tomato soup',
  'how tall is mount everest',
  'tell me about the second world war',
  'a joke about programmers',
  'the best font for reading on screen',
  'why is the sky blue',
  'list some good science fiction novels',
  'how do i bake bread at home',
];

const NONE_EVAL = [
  'write a song about the sea',
  'who invented the telephone',
  'a short story about a lighthouse',
  'explain what inflation means in economics',
  'recommend a film for tonight',
  'how far is the moon',
  'what should i eat this week',
  'a haiku about winter',
];

const LABELS = [...RECIPES.map((recipe) => recipe.id), NONE_LABEL];
const NONE_INDEX = RECIPES.length;

const corrupt = (text, random) => {
  if (text.length < 6) return text;
  const at = 1 + Math.floor(random() * (text.length - 3));
  const mode = Math.floor(random() * 3);
  if (mode === 0) return text.slice(0, at) + text.slice(at + 1);
  if (mode === 1) return text.slice(0, at) + text[at] + text.slice(at);
  return text.slice(0, at) + 'ieausrhn'[Math.floor(random() * 8)] + text.slice(at + 1);
};

const surfaceForms = (recipe) => {
  const forms = new Set(recipe.keywords);
  for (const word of recipe.title.toLowerCase().split(/[^a-z0-9 ]+/)) if (word.length > 3) forms.add(word);
  for (const teach of recipe.teaches || []) {
    for (const word of teach.toLowerCase().split(/[^a-z0-9 ]+/)) if (word.length > 5) forms.add(word);
  }
  if (recipe.defaultPrompt) forms.add(recipe.defaultPrompt);
  return [...forms].filter((form) => form && form.length > 2 && !/^\d/.test(form));
};

function buildCorpus(random) {
  const train = [];
  const evalHeld = [];
  const typoHeld = [];
  const owner = new Map();
  const shared = [];
  for (const recipe of RECIPES) {
    for (const form of surfaceForms(recipe)) {
      if (owner.has(form) && owner.get(form) !== recipe.id) shared.push(form);
      else owner.set(form, recipe.id);
    }
  }
  for (const recipe of RECIPES) {
    const y = LABELS.indexOf(recipe.id);
    for (const form of surfaceForms(recipe)) {
      // A surface form owned by another pattern is not this pattern's evidence;
      // keeping it would teach the model to answer two classes with one input.
      if (shared.includes(form) && owner.get(form) !== recipe.id) continue;
      for (const template of TRAIN_TEMPLATES) train.push({ x: template(form), y });
      for (const template of EVAL_TEMPLATES) {
        const brief = template(form);
        evalHeld.push({ x: brief, y });
        typoHeld.push({ x: corrupt(brief, random), y });
      }
    }
  }
  for (const brief of NONE_TRAIN) for (const template of TRAIN_TEMPLATES.slice(0, 5)) train.push({ x: template(brief), y: NONE_INDEX });
  for (const brief of NONE_EVAL) {
    evalHeld.push({ x: brief, y: NONE_INDEX });
    typoHeld.push({ x: corrupt(brief, random), y: NONE_INDEX });
  }
  return { train, evalHeld, typoHeld, sharedForms: shared };
}

const uniqueOf = (examples) => {
  const map = new Map();
  for (const example of examples) if (!map.has(example.x)) map.set(example.x, example.y);
  return [...map].map(([x, y]) => ({ x, y }));
};

// ------------------------------------------------------------------- train

function trainModel(corpus, { dims, hidden }, random) {
  const classes = LABELS.length;
  const scale = 1 / Math.sqrt(hidden);
  const E = [];
  for (let i = 0; i < dims; i += 1) {
    const row = new Float64Array(hidden);
    for (let j = 0; j < hidden; j += 1) row[j] = (random() * 2 - 1) * scale;
    E.push(row);
  }
  const W = [];
  for (let j = 0; j < hidden; j += 1) W.push(new Float64Array(classes));
  const bias = new Float64Array(classes);
  const features = corpus.train.map((example) => featurize(example.x, dims));
  const order = corpus.train.map((_, index) => index);
  const h = new Float64Array(hidden);
  const p = new Float64Array(classes);
  const d = new Float64Array(classes);
  const proj = new Float64Array(hidden);
  const wd = 1e-4;
  const history = [];

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const lr = 0.6 * (1 - epoch / (epochs + 1)) + 0.02;
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let correct = 0;
    let loss = 0;
    for (const index of order) {
      const y = corpus.train[index].y;
      const ids = features[index];
      if (!ids.length) continue;
      h.fill(0);
      for (const id of ids) {
        const row = E[id];
        for (let j = 0; j < hidden; j += 1) h[j] += row[j];
      }
      const k = ids.length;
      for (let j = 0; j < hidden; j += 1) h[j] /= k;
      let max = -Infinity;
      for (let c = 0; c < classes; c += 1) {
        let sum = bias[c];
        for (let j = 0; j < hidden; j += 1) sum += h[j] * W[j][c];
        p[c] = sum;
        if (sum > max) max = sum;
      }
      let total = 0;
      for (let c = 0; c < classes; c += 1) { p[c] = Math.exp(p[c] - max); total += p[c]; }
      // d is the NEGATIVE gradient of the loss wrt each logit, so every update
      // below adds lr * d. Writing it as (onehot - p) rather than (p - onehot)
      // is the difference between descent and ascent: with the other sign the
      // model runs away from the targets and settles on one confident class.
      for (let c = 0; c < classes; c += 1) {
        p[c] /= total;
        d[c] = c === y ? 1 - p[c] : -p[c];
      }
      let best = 0;
      for (let c = 1; c < classes; c += 1) if (p[c] > p[best]) best = c;
      if (best === y) correct += 1;
      loss += -Math.log(Math.max(p[y], 1e-12));
      for (let c = 0; c < classes; c += 1) bias[c] += lr * d[c];
      // One projection per hidden unit, reused for every feature row: without
      // it the update is O(features x hidden x classes) per example.
      for (let j = 0; j < hidden; j += 1) {
        const row = W[j];
        let projection = 0;
        for (let c = 0; c < classes; c += 1) {
          projection += row[c] * d[c];
          row[c] += lr * (h[j] * d[c] - wd * row[c]);
        }
        proj[j] = projection;
      }
      // The hidden vector is the MEAN of k feature rows, so each row carries
      // 1/k of the gradient that the hidden layer as a whole receives.
      const gain = lr / k;
      for (const id of ids) {
        const row = E[id];
        for (let j = 0; j < hidden; j += 1) row[j] += gain * proj[j] - lr * wd * row[j];
      }
    }
    history.push({ epoch: epoch + 1, loss: Number((loss / order.length).toFixed(6)), trainAccuracy: Number((correct / order.length).toFixed(6)) });
  }
  return { E, W, bias, history };
}

// ------------------------------------------------------- quantize and write

function quantize(model, { dims, hidden }) {
  const classes = LABELS.length;
  const { E, W, bias } = model;
  const rowScales = new Float32Array(dims);
  const E8 = new Int8Array(dims * hidden);
  for (let i = 0; i < dims; i += 1) {
    let absmax = 0;
    for (let j = 0; j < hidden; j += 1) absmax = Math.max(absmax, Math.abs(E[i][j]));
    if (absmax === 0) continue;
    const s = absmax / 127;
    rowScales[i] = s;
    for (let j = 0; j < hidden; j += 1) E8[i * hidden + j] = Math.round(E[i][j] / s);
  }
  const colScales = new Float32Array(classes);
  const W8 = new Int8Array(hidden * classes);
  for (let c = 0; c < classes; c += 1) {
    let absmax = 0;
    for (let j = 0; j < hidden; j += 1) absmax = Math.max(absmax, Math.abs(W[j][c]));
    const s = absmax === 0 ? 1 : absmax / 127;
    colScales[c] = s;
    for (let j = 0; j < hidden; j += 1) W8[j * classes + c] = Math.round(W[j][c] / s);
  }
  return { E8, rowScales, W8, colScales, bias: Float32Array.from(bias), dims, hidden, classes };
}

function toBytes(q, meta) {
  const header = Buffer.from(JSON.stringify(meta), 'utf8');
  const layout = layoutOf({ dims: q.dims, hidden: q.hidden, classes: q.classes, headerLength: header.length });
  const buffer = Buffer.alloc(layout.bytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  buffer.write(MODEL_MAGIC, 0, 'latin1');
  view.setUint32(4, MODEL_VERSION, true);
  view.setUint32(8, q.dims, true);
  view.setUint32(12, q.hidden, true);
  view.setUint32(16, q.classes, true);
  view.setUint32(20, header.length, true);
  header.copy(buffer, 24);
  for (let i = 0; i < q.E8.length; i += 1) buffer.writeInt8(q.E8[i], layout.embeddingAt + i);
  for (let i = 0; i < q.rowScales.length; i += 1) view.setFloat32(layout.rowScalesAt + 4 * i, q.rowScales[i], true);
  for (let i = 0; i < q.W8.length; i += 1) buffer.writeInt8(q.W8[i], layout.outputAt + i);
  for (let i = 0; i < q.colScales.length; i += 1) view.setFloat32(layout.colScalesAt + 4 * i, q.colScales[i], true);
  for (let i = 0; i < q.bias.length; i += 1) view.setFloat32(layout.biasAt + 4 * i, q.bias[i], true);
  return buffer;
}

// ---------------------------------------------------------------- measure

/** The shipped keyword matcher, answering exactly the same briefs. */
function matcherOf(briefs) {
  let hits = 0;
  const missed = [];
  for (const example of briefs) {
    const result = generate(example.x);
    if (result.matched.length > 0 && result.recipe.id === LABELS[example.y]) hits += 1;
    // `silent` is the case the panel actually uses the model for: a brief that
    // matched not one catalogue keyword. A wrong-but-matched brief is left to
    // the matcher, because overriding a confident keyword hit is a different
    // and much less conservative change.
    else missed.push({ x: example.x, y: example.y, silent: result.matched.length === 0 });
  }
  return { hits, of: briefs.length, missed };
}

function score(parsed, briefs) {
  let correct = 0;
  const wrong = [];
  const sample = briefs.length ? Math.max(1, Math.floor(briefs.length / 400)) : 1;
  const timings = [];
  for (let i = 0; i < briefs.length; i += 1) {
    const example = briefs[i];
    const started = process.hrtime.bigint();
    const prediction = classify(parsed, example.x, { threshold: INTENT_THRESHOLD });
    if (i % sample === 0) timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    const wanted = LABELS[example.y];
    const got = prediction.ok ? prediction.id : NONE_LABEL;
    if (got === wanted) correct += 1;
    else wrong.push({ brief: example.x, wanted, got, p: Number(prediction.p.toFixed(4)) });
  }
  timings.sort((a, b) => a - b);
  return {
    correct,
    of: briefs.length,
    accuracy: Number((correct / Math.max(1, briefs.length)).toFixed(6)),
    wrong: wrong.slice(0, 12),
    msPerBrief: { median: Number(timings[Math.floor(timings.length / 2)].toFixed(3)), slowest: Number((timings[timings.length - 1] || 0).toFixed(3)) },
  };
}

/**
 * The only figure that says the model added capability rather than merely
 * describing the same recall twice, plus the cost of using it: briefs the
 * matcher was silent on where the model commits to a pattern that is not the
 * one the brief asks for.
 */
function recoveryOf(parsed, briefs, baseline) {
  const silent = new Map();
  const missed = new Map();
  for (const item of baseline.missed) {
    missed.set(item.x, item.y);
    if (item.silent) silent.set(item.x, item.y);
  }
  let recovered = 0;
  let recoveredWhereSilent = 0;
  let wrongCommitments = 0;
  let declined = 0;
  for (const example of briefs) {
    if (!missed.has(example.x)) continue;
    const answer = classify(parsed, example.x, { threshold: INTENT_THRESHOLD });
    const right = answer.ok && answer.id === LABELS[example.y];
    if (right) {
      recovered += 1;
      if (silent.has(example.x)) recoveredWhereSilent += 1;
    } else if (!answer.ok) declined += 1;
    else if (silent.has(example.x)) wrongCommitments += 1;
  }
  return {
    briefsMatcherMissed: missed.size,
    matcherSilentBriefs: silent.size,
    recovered,
    recoveredWhereMatcherSilent: recoveredWhereSilent,
    wrongCommitmentsOnSilentBriefs: wrongCommitments,
    declinedOnMissedBriefs: declined,
  };
}

/**
 * The briefs where the model is the only thing in SINGU that answers at all:
 * the matcher found no keyword, and the network names a pattern. `right` picks
 * whether to list the recoveries or the wrong commitments. Printed so a
 * reviewer can paste one into the panel and see the claim hold, rather than
 * take a count on trust.
 */
function silentCases(parsed, briefs, baseline, right, limit = 8) {
  const missed = new Set(baseline.missed.filter((item) => item.silent).map((item) => item.x));
  const out = [];
  for (const example of briefs) {
    if (!missed.has(example.x)) continue;
    const answer = classify(parsed, example.x, { threshold: INTENT_THRESHOLD });
    if (!answer.ok || (answer.id === LABELS[example.y]) !== right) continue;
    out.push({
      brief: example.x,
      expected: LABELS[example.y],
      pattern: answer.id,
      probability: Number(answer.p.toFixed(4)),
    });
    if (out.length >= limit) break;
  }
  return out;
}

const catalogueFingerprint = () => createHash('sha256')
  .update(RECIPES.map((recipe) => `${recipe.id}:${[...recipe.keywords].sort().join('|')}`).sort().join('\n'))
  .digest('hex');

const gzipOf = (bytes) => gzipSync(bytes, { level: 9 }).length;

/** The loss curve thinned to about twenty points so the report stays readable. */
function curveOf(history) {
  const step = Math.max(1, Math.ceil(history.length / 20));
  return history.filter((row, index) => index % step === 0 || index === history.length - 1);
}

function runOne(dimensions, random) {
  const corpus = buildCorpus(prng(seed));
  const trained = trainModel(corpus, dimensions, random);
  // No timestamp in the artifact header: the weights come from a fixed seed and
  // a fixed corpus, so the file must be byte-for-byte reproducible or its
  // published SHA-256 means nothing. The run time belongs in the report.
  const bytes = toBytes(quantize(trained, dimensions), {
    labels: LABELS,
    catalogueFingerprint: catalogueFingerprint(),
    config: { dims: dimensions.dims, hidden: dimensions.hidden, epochs, seed },
  });
  const parsed = parse(new Uint8Array(bytes));
  const evalBriefs = uniqueOf(corpus.evalHeld);
  const typoBriefs = uniqueOf(corpus.typoHeld);
  return {
    dimensions,
    corpus,
    parsed,
    bytes,
    history: trained.history,
    evalBriefs,
    typoBriefs,
    eval: score(parsed, evalBriefs),
    typo: score(parsed, typoBriefs),
    matcherEval: matcherOf(evalBriefs),
    matcherTypo: matcherOf(typoBriefs),
  };
}

/**
 * One standard error of the held-out estimate. Two configs whose worst
 * held-out number differs by less than this are not distinguishable by the
 * evidence, so the size search must not pay parameters for the gap.
 */
const standardErrorOf = (r) => {
  const p = Math.min(r.eval.accuracy, r.typo.accuracy);
  const n = Math.min(r.eval.of, r.typo.of);
  return Math.sqrt((p * (1 - p)) / n);
};

/** The number the size search maximises: the weaker of the two held-out scores. */
const scoreOf = (r) => Math.min(r.eval.accuracy, r.typo.accuracy);

/**
 * Smallest configuration whose worst held-out score is within one standard
 * error of the best. Stated as a rule so the published parameter count is the
 * output of a measurement procedure, not a number someone settled on.
 */
function chooseResult(results) {
  const tolerance = Math.max(...results.map(standardErrorOf));
  const top = Math.max(...results.map(scoreOf));
  const candidates = results.filter((r) => top - scoreOf(r) <= tolerance);
  const chosen = candidates.reduce((a, b) => (parameterCount(b.parsed).total < parameterCount(a.parsed).total ? b : a));
  return {
    chosen,
    rule: 'smallest configuration whose worst held-out score is within one standard error of the best',
    standardError: Number(tolerance.toFixed(6)),
    bestScore: Number(top.toFixed(6)),
    insideTolerance: candidates.length,
    considered: results.length,
  };
}

/** Which classes the model actually emits, as a count per label. */
function spreadOf(parsed, briefs) {
  const counts = new Map();
  for (const example of briefs) {
    const prediction = classify(parsed, example.x, { threshold: INTENT_THRESHOLD });
    const key = prediction.ok ? prediction.id : `declined:${prediction.id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => ({ id, n }));
}

// -------------------------------------------------------------------- main

// The gate in tools/check-docs.js needs this number without importing the
// catalogue through a browser module, and without running a training it did not
// ask for, so the fingerprint has exactly one definition and a flag to print it.
if (flag('--fingerprint')) {
  process.stdout.write(`${catalogueFingerprint()}\n`);
  process.exit(0);
}

const results = flag('--sweep')
  ? SWEEP_SIZES.map((dimensions) => runOne(dimensions, prng(seed ^ 0x9e3779b9)))
  : [runOne(size, prng(seed ^ 0x9e3779b9))];
const selection = chooseResult(results);
const best = selection.chosen;
const rows = best.parsed;
const occupancy = trainedRows(rows);
const params = parameterCount(rows);

const report = {
  measuredAt: new Date().toISOString(),
  tool: 'tools/train-singu-model.js',
  subject: 'SINGU intent model: a trained embedding classifier over hashed character n-grams',
  artifact: {
    path: relative(root, outPath).replace(/\\/g, '/'),
    bytes: best.bytes.length,
    gzipBytes: gzipOf(best.bytes),
    sha256: createHash('sha256').update(best.bytes).digest('hex'),
  },
  architecture: 'averaged hashed-n-gram embedding with a linear softmax layer (fastText-supervised family); no vocabulary, no sampling, no generation',
  config: { dims: best.dimensions.dims, hidden: best.dimensions.hidden, epochs, seed },
  labels: { patterns: RECIPES.length, classes: LABELS.length, none: NONE_LABEL },
  parameters: params,
  training: curveOf(best.history),
  predictionSpread: spreadOf(best.parsed, best.evalBriefs),
  embeddingRowsTouched: { rows: occupancy.rows, of: occupancy.of, share: Number(occupancy.share.toFixed(4)) },
  sizing: {
    rule: selection.rule,
    standardError: selection.standardError,
    bestScore: selection.bestScore,
    considered: selection.considered,
    insideTolerance: selection.insideTolerance,
    configs: results.map((r) => ({
      dims: r.dimensions.dims,
      hidden: r.dimensions.hidden,
      parameters: parameterCount(r.parsed).total,
      heldOutTemplateAccuracy: r.eval.accuracy,
      heldOutTypoAccuracy: r.typo.accuracy,
      worstHeldOutScore: Number(scoreOf(r).toFixed(6)),
      bytes: r.bytes.length,
      gzipBytes: gzipOf(r.bytes),
      shipped: r === best,
    })),
  },
  supervision: {
    source: 'the catalogue itself: keywords, titles, teach lines and default prompts',
    catalogueFingerprint: catalogueFingerprint(),
    trainingBriefs: best.corpus.train.length,
    sharedSurfaceForms: best.corpus.sharedForms.length,
    caveat: 'The model is trained on the catalogue it selects from, so held-out accuracy measures generalisation to unseen PHRASINGS of known patterns. It does not measure any ability to recognise a pattern the catalogue does not contain, and it is not a language model.',
  },
  heldOutTemplate: {
    ...best.eval,
    baselineMatcher: { hits: best.matcherEval.hits, of: best.matcherEval.of },
    recovery: recoveryOf(best.parsed, best.evalBriefs, best.matcherEval),
  },
  heldOutTypos: {
    ...best.typo,
    baselineMatcher: { hits: best.matcherTypo.hits, of: best.matcherTypo.of },
    recovery: recoveryOf(best.parsed, best.typoBriefs, best.matcherTypo),
  },
  panelUse: {
    consultedWhen: 'the composer found no task and the catalogue keyword matcher returned no match at all',
    threshold: INTENT_THRESHOLD,
    decides: 'which of the 15 catalogue patterns to render; it never emits source',
    note: 'A brief the matcher answered, even wrongly, is left with the matcher. That is why recoveredWhereMatcherSilent, not recovered, is the number the shipped page earns.',
  },
  sampleSilentRecoveries: silentCases(best.parsed, best.evalBriefs, best.matcherEval, true),
  sampleTypoRecoveries: silentCases(best.parsed, best.typoBriefs, best.matcherTypo, true),
  sampleWrongCommitments: silentCases(best.parsed, best.typoBriefs, best.matcherTypo, false),
  notes: [
    'Accuracy is measured on the quantized int8 bytes that ship, not on the float32 weights before compression.',
    'The parameter count is read back from the artifact through src/assistant/model.js parse(), so the published figure and the file cannot disagree.',
    'Rows of the embedding table the corpus never touched are reported separately: they are allocated and counted, but they contribute nothing to a prediction.',
    'sizing.configs is the whole size search, including the rows that lost. The shipped count is chosen by sizing.rule, not by hand.',
    'Re-running node tools/train-singu-model.js --sweep reproduces artifact.sha256 exactly: the seed, the corpus, the corruption stream and the learning-rate schedule are all fixed, and no timestamp is written into the weight file. If the digest moves, the weights moved.',
  ],
};

// An artifact that ships without the size search beside it publishes a
// parameter count nobody can check, so the sweep is not optional here.
if (!asJson && !flag('--sweep')) {
  process.stderr.write('refusing to write an artifact from a single configuration: run with --sweep so the report carries the size search\n');
  process.exit(2);
}

if (!asJson) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, best.bytes);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    written: [relative(root, outPath).replace(/\\/g, '/'), relative(root, reportPath).replace(/\\/g, '/')],
    parameters: params.total,
    bytes: best.bytes.length,
    gzipBytes: gzipOf(best.bytes),
    heldOutTemplateAccuracy: best.eval.accuracy,
    heldOutTypoAccuracy: best.typo.accuracy,
    matcherBaselineTemplate: `${best.matcherEval.hits}/${best.matcherEval.of}`,
    matcherBaselineTypo: `${best.matcherTypo.hits}/${best.matcherTypo.of}`,
    recoveredWhereMatcherSilentTemplate: recoveryOf(rows, best.evalBriefs, best.matcherEval).recoveredWhereMatcherSilent,
    recoveredWhereMatcherSilentTypo: recoveryOf(rows, best.typoBriefs, best.matcherTypo).recoveredWhereMatcherSilent,
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
