/**
 * Project Singularity — the deployed worker (template).
 *
 * The app is static; this worker exists for exactly one reason: to attach the
 * response headers a static host cannot deliver by itself — `frame-ancestors`,
 * COOP and COEP, the three directives a `<meta http-equiv>` policy cannot
 * express (see docs/DEPLOY.md). Everything else is `env.ASSETS.fetch`.
 *
 * The policy is **not written by hand here**. `tools/build-site.py` parses the
 * repository's `_headers` file — the same file the local dev servers read — and
 * substitutes it into the single placeholder below, so the deployed policy and
 * the policy the tests exercise are the same rules from the same source. The
 * matcher implements the `_headers` semantics both Netlify and Cloudflare
 * document: `*` matches within one path segment, and later rules override
 * earlier ones per header name.
 */
const POLICY = __POLICY_JSON__;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function patternMatches(pattern, pathname) {
  if (pattern === '/*' || pattern === '*') return true;
  const parts = pattern.split('*').map(escapeRe);
  return new RegExp(`^${parts.join('[^/]*')}$`).test(pathname);
}

export function headersFor(rules, pathname) {
  const out = new Map();
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) out.set(name.toLowerCase(), { name, value });
  }
  return [...out.values()];
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const { name, value } of headersFor(POLICY, new URL(request.url).pathname)) {
      headers.set(name, value);
    }
    // 101/204/205/304 must not carry a body; everything else is copied through
    // untouched, so an asset-layer 404 stays a 404 with the policy attached.
    const bodyless =
      response.status === 101 ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304;
    return new Response(bodyless ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
