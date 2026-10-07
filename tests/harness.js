// Minimal, dependency-free test harness (the challenge forbids npm libraries).
let registry = [];

export function test(name, fn) {
  registry.push({ name, fn });
}

/** Take the tests registered since the last call (per suite). */
export function collect() {
  const out = registry;
  registry = [];
  return out;
}

export async function runTests(tests) {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
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
  return { pass, fail };
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
