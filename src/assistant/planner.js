/**
 * SINGU planner - one brief, two deterministic engines and a model as a net.
 *
 * `compose()` covers everyday C (sums, strings, primes); the systems catalogue
 * in singu.js covers ring buffers, allocators and wire formats. Neither can
 * answer the other's briefs well, so this facade runs both, picks the stronger
 * match, and returns the same shape either way. The panel, the autopilot and
 * the tests can therefore stay engine-agnostic; only `engine` and the optional
 * acceptance `tests` differ.
 *
 * The third path is the trained intent model, used only where both deterministic
 * engines are silent: no composer task fitted, and not one catalogue keyword
 * matched. It chooses a pattern id and nothing else - the program still comes
 * out of the hand-written generator, so the guarantee that emitted C compiles is
 * untouched by the network.
 */

import { generate } from './singu.js';
import { compose } from './compose.js';
import { INTENT_THRESHOLD } from './model.js';
import { selectIntent } from './intent.js';

export const PLANNER_VERSION = '1.1';

export const ENGINE_LABELS = Object.freeze({
  composer: 'Composer',
  catalogue: 'Systems catalogue',
  intent: 'Intent model',
});

const text = (value) => String(value == null ? '' : value).trim();

function alternativesFor(primary, composed, generated) {
  const list = [];
  const add = (title, prompt, level, engine) => {
    if (title && !list.some((item) => item.title === title)) list.push({ title, prompt, level, engine });
  };
  if (primary === 'composer') {
    for (const item of composed.aside) add(item.title, item.prompt, item.level, 'composer');
    for (const item of composed.alternatives) add(item.title, item.prompt, item.level, 'composer');
    for (const item of generated.alternatives) add(item.title, item.defaultPrompt, item.level, 'catalogue');
  } else {
    for (const item of generated.alternatives) add(item.title, item.defaultPrompt, item.level, 'catalogue');
    if (composed) for (const item of [composed, ...composed.alternatives]) add(item.title, item.defaultPrompt, item.level, 'composer');
  }
  return list.slice(0, 4);
}

function fromComposer(composed, generated, brief) {
  return {
    ok: true,
    engine: 'composer',
    prompt: brief,
    title: composed.title,
    summary: composed.summary,
    level: composed.level,
    levelOnly: false,
    confidence: composed.confidence,
    matched: composed.matched,
    code: composed.code,
    plan: composed.plan,
    notes: composed.notes,
    hazards: composed.hazards,
    teaches: composed.teaches,
    complexity: composed.complexity,
    params: composed.params,
    tests: composed.tests,
    steps: composed.steps,
    aside: composed.aside,
    alternatives: alternativesFor('composer', composed, generated),
  };
}

function fromCatalogue(generated, composed) {
  return {
    ok: true,
    engine: 'catalogue',
    prompt: generated.prompt,
    title: generated.recipe.title,
    summary: generated.recipe.summary,
    level: generated.level,
    levelOnly: generated.levelOnly,
    confidence: generated.confidence,
    matched: generated.matched,
    code: generated.code,
    plan: generated.plan,
    notes: generated.recipe.notes,
    hazards: generated.recipe.hazards,
    teaches: generated.recipe.teaches,
    complexity: generated.recipe.complexity,
    params: generated.params,
    tests: [],
    steps: [],
    aside: [],
    recipe: generated.recipe,
    alternatives: alternativesFor('catalogue', composed, generated),
  };
}

/**
 * Plan one program. `options.engine` is 'auto' (default), 'composer' or
 * 'catalogue'; `options.level` is a level name or 'auto'; `options.model` is a
 * parsed intent artifact, and is consulted only when both engines come up empty.
 */
export function plan(prompt, options = {}) {
  const brief = text(prompt);
  const level = options.level && options.level !== 'auto' ? options.level : undefined;
  const composed = brief ? compose(brief, { level }) : null;
  const generated = generate(brief, options);
  const askedForEngine = options.engine === 'composer' || options.engine === 'catalogue';
  if (brief && !composed && !askedForEngine && generated.matched.length === 0 && options.model) {
    const intent = selectIntent(options.model, brief);
    if (intent) {
      const chosen = generate(brief, { ...options, recipeId: intent.id, confidence: intent.p, ranked: intent.ranked });
      const result = fromCatalogue(chosen, composed);
      result.engine = 'intent';
      result.intent = {
        id: intent.id,
        probability: Number(intent.p.toFixed(4)),
        threshold: INTENT_THRESHOLD,
        runnersUp: intent.ranked.slice(1).map((entry) => ({ id: entry.id, probability: Number(entry.p.toFixed(4)) })),
      };
      return result;
    }
  }
  let engine = options.engine || 'auto';
  if (engine !== 'composer' && engine !== 'catalogue') {
    // A composer match agrees with the brief in its own words; the catalogue
    // wins only when it is measurably more confident (e.g. "sort a linked list"
    // is the catalogue's linked-list brief, not the array sort).
    engine = composed && composed.confidence >= generated.confidence - 0.02 ? 'composer' : 'catalogue';
  }
  if (engine === 'composer' && !composed) engine = 'catalogue';
  return engine === 'composer' ? fromComposer(composed, generated, brief) : fromCatalogue(generated, composed);
}
