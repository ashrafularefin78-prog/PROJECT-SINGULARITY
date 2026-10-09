// Minimal, dependency-free test harness (the challenge forbids npm libraries).
let registry = [];

/**
 * What the test can actually exercise in *this* context.
 *
 * The same suites run in two places: bare Node (fast, no browser) and a real
 * browser (authoritative - it has WebGL2 and IndexedDB). A test that needs a
 * browser facility declares it in `needs`, so the Node run reports it as
 * `skip` rather than as a failure. That keeps `npm test`'s exit code honest:
 * a red run means a real regression, never "this machine has no GPU".
 */
export function capabilities() {
  const dom = typeof document !== 'undefined';
  let webgl2 = false;
  if (dom) {
    try {
      const canvas = document.createElement('canvas');
      webgl2 = !!canvas.getContext('webgl2');
    } catch {
      webgl2 = false;
    }
  }
  return {
    dom,
    webgl2,
    indexeddb: typeof indexedDB !== 'undefined',
  };
}

/** Test options: `{ needs: 'webgl2' }` or `{ needs: ['dom', 'webgl2'] }`. */
export function test(name, fn, options = {}) {
  const needs = options.needs
    ? (Array.isArray(options.needs) ? options.needs : [options.needs])
    : [];
  registry.push({ name, fn, needs });
}

/** Take the tests registered since the last call (per suite). */
export function collect() {
  const out = registry;
  registry = [];
  return out;
}

/** Why a test cannot run here, or null when it can. */
export function unmetNeeds(t, caps = capabilities()) {
  for (const need of t.needs || []) {
    if (!caps[need]) return `${need} is not available in this context`;
  }
  return null;
}

export async function runTests(tests, caps = capabilities()) {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const t of tests) {
    const why = unmetNeeds(t, caps);
    if (why) {
      skip += 1;
      console.log('  \u001b[33mskip\u001b[0m ' + t.name + ' (' + why + ')');
      continue;
    }
    try {
      await t.fn();
      pass += 1;
      console.log('  \u001b[32mok\u001b[0m   ' + t.name);
    } catch (err) {
      fail += 1;
      console.error('  \u001b[31mFAIL\u001b[0m ' + t.name);
      console.error('       ' + (err && err.message ? err.message : String(err)));
    }
  }
  return { pass, fail, skip };
}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

export function assertEquals(actual, expected, msg = 'values differ') {
  if (actual !== expected) {
    throw new Error(`${msg}\n       expected: ${fmt(expected)}\n       actual:   ${fmt(actual)}`);
  }
}

export function assertDeepEquals(actual, expected, msg = 'values differ') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n       expected: ${b}\n       actual:   ${a}`);
}

export function assertThrows(fn, msg = 'expected a throw') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(msg);
}

function fmt(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}
