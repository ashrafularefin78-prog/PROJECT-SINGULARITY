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
