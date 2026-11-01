/**
 * Lazy load of the trained intent model.
 *
 * The weights are a 41 KB file fetched once, on first use of the SINGU panel,
 * from the same origin. Nothing about the page's cold load depends on it: if the
 * fetch fails, the file is missing, or the bytes do not parse, the model is
 * simply absent and the planner behaves exactly as it did before the model
 * existed. That is the point of keeping the loader in its own module - the
 * deterministic engines never have to know whether this one loaded.
 *
 * The narrow use is in planner.js: the model is consulted only when the keyword
 * matcher found nothing at all, which is the population its published recovery
 * number is measured over.
 */

import { INTENT_THRESHOLD, classify, parse, parameterCount } from './model.js';

const WEIGHT_URL = new URL('../../assets/models/singu-intent.bin', import.meta.url).href;

const initial = { status: 'idle', model: null, parameters: 0, bytes: 0, error: '' };
let state = initial;
let pending = null;

export const intentStatus = () => state;

/**
 * Fetch, parse and cache the weights. Resolves with the model or null; it never
 * rejects, because an unavailable model is a normal state for this app rather
 * than an error the caller has to handle.
 */
export async function loadIntentModel({ url = WEIGHT_URL, fetcher = fetch } = {}) {
  if (state.status === 'ready') return state.model;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`weight fetch answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const model = parse(bytes);
    state = {
      status: 'ready',
      model,
      parameters: parameterCount(model).total,
      bytes: model.bytes,
      error: '',
    };
    return model;
  })().catch((error) => {
    state = { ...initial, status: 'failed', error: error.message };
    pending = null;
    return null;
  });
  return pending;
}

/**
 * The pattern the model thinks the brief asks for, or null when it does not
 * commit. `ok` already means "not the none class and above the threshold", so
 * the caller only has to check for null.
 */
export function selectIntent(model, text) {
  if (!model) return null;
  const answer = classify(model, text, { threshold: INTENT_THRESHOLD });
  return answer.ok ? answer : null;
}
