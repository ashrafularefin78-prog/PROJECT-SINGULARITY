/**
 * Does the server deliver the policy in `_headers`?
 *
 *   node tools/verify-headers.js
 *
 * This is the check behind the claim "the M8 protections are actually
 * delivered". It starts the dev server, requests a document, the service
 * worker and a module, and compares the received headers with what `_headers`
 * says they should be - so a header that is written in the file but dropped by
 * the server (or by a host that does not read the file) fails loudly.
 *
 * It also asserts the three directives that a <meta> tag cannot express, since
 * those are the ones the brief's feedback called out for GitHub Pages.
 */
import { headersFor, loadHeaderRules, patternMatches } from './headers.js';
import { parseArgs, startProjectServer } from './cdp.js';

const args = parseArgs();

const REQUIRED_BY_META_LIMITATION = [
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
];

const PATHS = ['/', '/index.html', '/sw.js', '/src/app.js', '/styles/app.css'];

// `--url=https://site/` checks a deployment; without it a local server is started.
const remote = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
const local = remote ? null : await startProjectServer({ port: Number(process.env.HEADERS_PORT || 5206) });
const origin = remote || local.origin;
let failures = 0;
try {
  const rules = loadHeaderRules();
  console.log(`# _headers: ${rules.length} rule sets (${rules.map((r) => r.pattern).join(', ')})`);
  for (const path of PATHS) {
    const res = await fetch(origin + path);
    const received = new Map([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    const expected = headersFor(rules, path);
    const missing = [];
    const wrong = [];
    for (const { name, value } of expected) {
      if (name.toLowerCase() === 'cache-control') continue; // dev server owns caching
      const got = received.get(name.toLowerCase());
      if (!got) missing.push(name);
      else if (got !== value) wrong.push(`${name}: expected "${value}", got "${got}"`);
    }
    const status = res.status;
    const ok = status === 200 && !missing.length && !wrong.length;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${path.padEnd(16)} status ${status}` + (ok ? '' : ` | missing: ${missing.join(', ') || '-'} | ${wrong.join('; ')}`));
    if (!ok) failures += 1;
  }

  // The directives that cannot be expressed in HTML: if these are absent the
  // site depends on the host reading _headers at all.
  const index = await fetch(origin + '/');
  for (const name of REQUIRED_BY_META_LIMITATION) {
    const value = index.headers.get(name);
    const pass = !!value;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}: ${value || 'ABSENT'}`);
    if (!pass) failures += 1;
  }

  // A host that ignores _headers is the failure mode this whole task is about:
  // report it explicitly rather than letting the check pass silently.
  const githubPagesIgnores = !patternMatches('/*', '/') || rules.length === 0;
  if (githubPagesIgnores) {
    console.log('  FAIL _headers has no rule for /*, so nothing would be delivered anywhere');
    failures += 1;
  }
} finally {
  if (local) local.proc.kill();
}

console.log(failures ? `\n${failures} header check(s) failed` : '\nall headers delivered as _headers specifies');
process.exit(failures ? 1 : 0);
