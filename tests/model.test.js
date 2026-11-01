/**
 * M9 - the trained intent model.
 *
 * The claim under test is narrow, and these tests only check that claim: a real
 * weight file loads, parses, and names a catalogue pattern for a brief the
 * keyword matcher cannot answer - and the program it picks still compiles and
 * runs in the M2 interpreter. Nothing here asks the model to be clever. It is
 * asked to be honest about its own shapes: the parameter count comes out of the
 * file, the labels come out of the file, and a file that lies about its layout
 * is refused rather than trusted.
 *
 * Order matters in this file: assistant/intent.js caches one load for the
 * process, so the unavailable-weights case has to run before anything succeeds.
 */
import { test, assert, assertEquals, assertDeepEquals, assertThrows } from './harness.js';
import { RECIPES, generate } from '../src/assistant/singu.js';
import { plan, ENGINE_LABELS } from '../src/assistant/planner.js';
import { interpret } from '../src/runtime/interpreter.js';
import * as intent from '../src/assistant/intent.js';
import {
  INTENT_THRESHOLD, MODEL_VERSION, NONE_LABEL, featurize, layoutOf, normaliseBrief,
  parse, parameterCount, softmax, classify, trainedRows,
} from '../src/assistant/model.js';

const WEIGHT_URL = new URL('../assets/models/singu-intent.bin', import.meta.url);

async function bytesOf(url) {
  if (typeof document === 'undefined') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fixture ${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const rawWeights = bytesOf(WEIGHT_URL);

test('intent: weights that cannot be fetched leave the planner exactly as it was', async () => {
  const model = await intent.loadIntentModel({
    url: 'assets/models/definitely-not-here.bin',
    fetcher: async () => new Response('gone', { status: 404 }),
  });
  assertEquals(model, null, 'a failed weight fetch resolves to no model instead of throwing');
  assertEquals(intent.intentStatus().status, 'failed');
  assert(intent.intentStatus().error.includes('404'), `the reason is kept for the panel: ${intent.intentStatus().error}`);

  const result = plan('a lock free queue', { model: null });
  assert(result.engine !== 'intent', 'with no model the planner cannot claim to have used one');
  assert(result.code.includes('int'), 'and it still emits C');
});

test('intent: the shipped artifact parses, and every shape is read from the file', async () => {
  const model = parse(await rawWeights);
  assertEquals(model.dims, 2048, 'embedding rows');
  assertEquals(model.hidden, 16, 'hidden units');
  assertEquals(model.classes, RECIPES.length + 1, 'one class per pattern plus the none class');
  assertEquals(model.labels[model.labels.length - 1], NONE_LABEL, 'the last class is "none of these"');
  assertEquals(model.meta.config.epochs, 160, 'the training run is recorded in the file');
  assertDeepEquals(model.meta.labels, model.labels, 'the header labels are the ones the classifier uses');

  const params = parameterCount(model);
  assertEquals(params.embedding, model.dims * model.hidden, 'the embedding term is the table the file carries');
  assertEquals(params.total, params.embedding + params.output + params.bias, 'no term is quietly dropped');
  assert(params.total > 1000 && params.total < 1e6, `the count is a measured size, not a round number: ${params.total}`);

  const rows = trainedRows(model);
  assertEquals(rows.of, model.dims, 'the row census covers the whole table');
  assert(rows.rows > rows.of * 0.5, `most rows carry weight: ${rows.rows}/${rows.of}`);
});

test('intent: a file that lies about its layout is refused, not trusted', async () => {
  const good = await rawWeights;
  const bad = new Uint8Array(good);
  bad[0] = 'X'.charCodeAt(0);
  assertThrows(() => parse(bad), 'wrong magic');

  const wrongVersion = new Uint8Array(good);
  new DataView(wrongVersion.buffer).setUint32(4, MODEL_VERSION + 1, true);
  assertThrows(() => parse(wrongVersion), 'unsupported version');

  assertThrows(() => parse(good.slice(0, good.length - 64)), 'truncated weights');
  assertThrows(() => parse(good.slice(0, 8)), 'a header with no body');
  assertThrows(() => parse(new Uint8Array(good.length).fill(0)), 'all zeros');

  const wrongDims = new Uint8Array(good);
  new DataView(wrongDims.buffer).setUint32(8, 2047, true);
  assertThrows(() => parse(wrongDims), 'dims that are not a power of two');
});

test('intent: layoutOf is the single definition of the format', async () => {
  const good = await rawWeights;
  const view = new DataView(good.buffer);
  const dims = view.getUint32(8, true);
  const hidden = view.getUint32(12, true);
  const classes = view.getUint32(16, true);
  const headerLength = view.getUint32(20, true);
  const layout = layoutOf({ dims, hidden, classes, headerLength });
  assertEquals(layout.bytes, good.length, 'the declared shapes account for every byte in the file');
  assertEquals(layout.embeddingAt % 4, 0, 'the int8 table starts on a whole float');
  assertEquals(layout.rowScalesAt % 4, 0, 'and so does every f32 section');
  assertEquals(layout.biasAt + 4 * classes, layout.bytes, 'the bias is the last thing in the file');
});

test('intent: features are deterministic and normalisation is total', () => {
  const a = featurize('  A Ring-Buffer  for SPSC!! ', 2048);
  const b = featurize('a ring-buffer for spsc', 2048);
  assertDeepEquals(a, b, 'case and punctuation carry no signal');
  assert(a.length > 3, 'a real brief produces word and n-gram features');
  assertEquals(normaliseBrief('aaaa'), 'aaaa');
  assertEquals(normaliseBrief(null), '');
  assertDeepEquals(featurize('anything at all', 1024), featurize('anything at all', 1024), 'same input, same ids, same order');
  for (const id of featurize('anything', 1024)) assert(id >= 0 && id < 1024, 'every id is inside the table');
  assertThrows(() => featurize('x', 1000), 'dims must be a power of two');
});

test('intent: the loaded model names patterns the keyword matcher cannot', async () => {
  const model = parse(await rawWeights);
  const briefs = [
    ['do abitwise', 'bit-toolkit'],
    ['a working nits in c', 'bit-toolkit'],
    ['slab alocator with 4k blocks', 'slab-pool'],
    ['mmio register map for a fake uart', 'mmio-registers'],
  ];
  for (const [brief, wanted] of briefs) {
    assertEquals(classify(model, brief, { threshold: INTENT_THRESHOLD }).id, wanted, brief);
  }
});

test('intent: an off-topic brief is declined rather than forced into a pattern', async () => {
  const model = parse(await rawWeights);
  for (const brief of ['write a song about the sea', 'a recipe for tomato soup', 'who invented the telephone', '']) {
    const answer = classify(model, brief, { threshold: INTENT_THRESHOLD });
    assert(!answer.ok, `"${brief}" must not commit to a pattern (got ${answer.id} at ${answer.p.toFixed(3)})`);
    assertEquals(answer.ranked.length, 3, 'the runner-ups are kept for the panel');
  }
  const result = plan('a recipe for tomato soup', { model });
  assert(!result.intent, 'the planner records no intent decision when the model declines');
});

test('intent: softmax is a distribution, and shifts of the same logits agree', () => {
  const p = softmax([1, 2, 3]);
  assertEquals(p.length, 3, 'one probability per class');
  assert(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-12, 'the probabilities sum to one');
  assert(p[2] > p[1] && p[1] > p[0], 'higher logit, higher probability');
  assertDeepEquals(Array.from(softmax([1, 2, 3])), Array.from(softmax([11, 12, 13])), 'the max is subtracted before exponentiating');
  assert(softmax([0])[0] === 1, 'a single class is certain');
});

test('intent: the planner uses the model only where both engines are silent', async () => {
  const model = parse(await rawWeights);
  const covered = plan('a 64-bit bitset with set, clear and count', { level: 'low', model });
  assertEquals(covered.engine, 'catalogue', 'a brief with matching keywords never reaches the model');
  assert(!covered.intent, 'and so carries no intent record');

  const forced = plan('do a two test', { model, engine: 'catalogue' });
  assert(forced.engine !== 'intent', 'an explicitly requested engine is honoured over the model');
});

test('intent: a model-chosen program still compiles and runs', async () => {
  const model = parse(await rawWeights);
  let chosen = 0;
  for (const brief of ['do abitwise', 'a working nits in c', 'slab alocator with 4k blocks', 'mmio register map for a fake uart']) {
    if (generate(brief).matched.length > 0) continue;
    const result = plan(brief, { model });
    if (result.engine !== 'intent') continue;
    chosen += 1;
    assertEquals(ENGINE_LABELS[result.engine], 'Intent model', 'the panel can label the engine that answered');
    assertEquals(result.title, RECIPES.find((r) => r.id === result.intent.id).title, 'the panel shows the pattern the model named');
    assert(result.confidence >= INTENT_THRESHOLD, 'the displayed confidence is the model probability');
    assert(result.plan.some((line) => line.includes('intent model')), `${brief}: the plan says the model made this choice`);
    const executed = interpret(result.code, {});
    assert(executed.ok, `${brief}: ${executed.error && executed.error.message}`);
    assert(executed.output.length > 0, `${brief} prints a trace`);
  }
  assert(chosen >= 2, `at least two of the four briefs are model-chosen (saw ${chosen})`);
});

test('intent: weights are fetched once and cached for the session', async () => {
  let calls = 0;
  const model = await intent.loadIntentModel({
    url: 'assets/models/singu-intent.bin',
    fetcher: async () => {
      calls += 1;
      return new Response(await rawWeights);
    },
  });
  assert(model, 'the lazy load succeeds from the panel path');
  assertEquals(calls, 1, 'the first call fetches');
  const again = await intent.loadIntentModel({ fetcher: async () => { calls += 1; return new Response('unreachable'); } });
  assertEquals(calls, 1, 'a ready model is never re-fetched');
  assert(again === model, 'and the same parsed artifact is handed back');
  assertEquals(intent.intentStatus().parameters, parameterCount(model).total, 'the panel reads the count out of the file');
  assertEquals(intent.intentStatus().bytes, model.bytes, 'and the byte size out of the file');
});

test('intent: the published report describes the file that ships', async () => {
  let report = null;
  try {
    const url = new URL('../docs/reports/singu-intent.json', import.meta.url);
    if (typeof document === 'undefined') {
      const { readFile } = await import('node:fs/promises');
      report = JSON.parse(await readFile(url, 'utf8'));
    } else {
      const response = await fetch(url);
      if (response.ok) report = await response.json();
    }
  } catch {
    /* the report is not served in this context; the check-docs gate covers it */
  }
  if (!report) return;
  const model = parse(await rawWeights);
  const raw = await rawWeights;
  assertEquals(report.parameters.total, parameterCount(model).total, 'published parameters are the file\u2019s own shapes');
  assertEquals(report.artifact.bytes, raw.length, 'published size is the file\u2019s size');
  assertEquals(report.config.dims, model.dims, 'published config is the file\u2019s config');
  assertEquals(report.labels.classes, model.classes, 'published class count is the file\u2019s count');
  assertEquals(report.supervision.catalogueFingerprint, model.meta.catalogueFingerprint, 'the artifact was trained against the catalogue that ships');
  assert(report.sizing.configs.length > 1, 'the published count carries the size search that produced it');
  assert(report.sizing.configs.some((row) => row.shipped), 'and names which row shipped');
  assert(report.heldOutTypos.recovery.wrongCommitmentsOnSilentBriefs >= 0, 'the cost of using the model is published, not hidden');
});
