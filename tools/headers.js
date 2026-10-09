/**
 * The `_headers` file is the single source of truth for this project's response
 * headers, because that is the file Cloudflare Pages and Netlify read.
 *
 * GitHub Pages ignores it, which is exactly why the live site had no
 * frame-ancestors, COOP or COEP: those three cannot be expressed by the
 * <meta http-equiv> fallback in index.html. Making the *local* dev server read
 * the same file means "tested under the shipped policy" is literally true
 * rather than a promise: whatever the host delivers, the local server delivers,
 * from one source.
 *
 * Format (Cloudflare Pages / Netlify `_headers`):
 *   /pattern
 *     Header-Name: value
 * A `*` matches within one path segment, as both hosts define it. Later rules
 * override earlier ones for the same header, which is Netlify's documented
 * behaviour and the intuitive reading of a file you scan downwards.
 */
import { readFileSync } from 'node:fs';

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const m = /^\s*([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m && current) current.headers.push([m[1], m[2]]);
  }
  return rules;
}

/** Does one `_headers` pattern match this request path? */
export function patternMatches(pattern, pathname) {
  if (pattern === '/*' || pattern === '*') return true;
  const parts = pattern.split('*').map(escapeRe);
  return new RegExp(`^${parts.join('[^/]*')}$`).test(pathname);
}

/** The headers to send for `pathname`, latest rule wins per header name. */
export function headersFor(rules, pathname) {
  const out = new Map();
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) out.set(name.toLowerCase(), { name, value });
  }
  return [...out.values()];
}

export function loadHeaderRules(file = '_headers') {
  try {
    return parseHeaders(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
