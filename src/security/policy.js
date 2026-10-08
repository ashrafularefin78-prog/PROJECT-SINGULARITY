/**
 * M8 - Hostile-environment hardening: Trusted Types.
 *
 * The app ships with `require-trusted-types-for 'script'`, which means the
 * browser refuses plain strings in DOM XSS sinks (innerHTML, Worker script
 * URLs, service worker registration, eval...). Rather than weaken the policy we
 * create a single narrowly-scoped policy that only ever mints *same-origin*
 * script URLs. There is no policy for TrustedHTML at all, so `innerHTML`
 * remains unusable throughout the codebase by construction.
 */

let policy = null;

function getPolicy() {
  if (policy) return policy;
  const tt = globalThis.trustedTypes;
  if (!tt || typeof tt.createPolicy !== 'function') return null;
  try {
    policy = tt.createPolicy('singularity#script-url', {
      createScriptURL: (input) => {
        const url = new URL(String(input), globalThis.location.href);
        if (url.origin !== globalThis.location.origin) {
          throw new TypeError(`blocked cross-origin script URL: ${input}`);
        }
        return url.href;
      },
    });
  } catch {
    policy = null; // a policy with this name already exists - reuse the browser's
  }
  return policy;
}

/** Mint a TrustedScriptURL for a same-origin worker/script. */
export function scriptUrl(input) {
  const url = new URL(String(input), globalThis.location.href);
  if (url.origin !== globalThis.location.origin) {
    throw new TypeError(`blocked cross-origin script URL: ${input}`);
  }
  const p = getPolicy();
  return p ? p.createScriptURL(url.href) : url.href;
}

export function trustedTypesActive() {
  return !!(globalThis.trustedTypes && globalThis.trustedTypes.createPolicy);
}

/**
 * A DOM helper that can only ever produce text nodes. No innerHTML anywhere,
 * which keeps the app compatible with the strict CSP and immune to markup
 * injection from peer-supplied data.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

/**
 * M8 - Ingress rate limiting.
 *
 * A peer (or a bug, or a runaway script) that floods the room can otherwise pin
 * the CPU and drown the presence UI. This is a per-peer token bucket with a
 * small burst allowance, so ordinary chatter never notices it and a flood is
 * capped.
 *
 * Deliberately NOT applied to document operations or sync replies: dropping one
 * of those would lose a character, and "we dropped your edit to save CPU" is not
 * a trade this app is willing to make. Presence is throttled; the document is
 * not.
 */
export class RateLimiter {
  /** @param {object} options @param {number} options.rate refills per second
   *  @param {number} options.burst maximum tokens held */
  constructor({ rate = 40, burst = 80 } = {}) {
    this.rate = rate;
    this.burst = burst;
    this.buckets = new Map();
    this.throttled = 0;
  }

  /** True when this key may proceed. Refills by elapsed time, so a quiet peer
   *  is never penalised for an old burst. */
  allow(key, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.rate);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.throttled += 1;
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Forget a peer's bucket (it left the room, or recovered). */
  forget(key) {
    this.buckets.delete(key);
  }

  get size() {
    return this.buckets.size;
  }
}
