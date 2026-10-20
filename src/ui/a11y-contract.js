/**
 * M7 - an accessibility contract that the page is checked against, rather than
 * a claim in a README.
 *
 * Two halves, both dependency-free and both testable:
 *
 *   1. `auditTree(root)` walks the live DOM and reports what a screen reader
 *      would find wrong: unnamed controls, skipped heading levels, a missing
 *      landmark, an image without alternative text, positive tabindex, a
 *      canvas with no text alternative, and a focusable element hidden from
 *      assistive tech. Each rule has an id, a WCAG reference and a severity,
 *      so a finding is actionable rather than a style opinion.
 *
 *   2. `parallelTextTree(root)` renders the accessibility tree as indented
 *      text - role, accessible name, state. That is the "parallel tree" the
 *      brief asks for: the canvas scene publishes one (see describeScene in
 *      src/graphics/renderer.js), and this one covers the document, which is
 *      what makes the 3D render's invisibility to assistive tech visible in
 *      the interface instead of only in the code.
 *
 * The audit is deliberately conservative: it reports what it can prove from
 * the DOM and computed styles, and it never invents a rule it cannot check.
 * That is why `notChecked` is part of the result - an audit that silently
 * checks nothing looks exactly like a passing one.
 */

/** Colour contrast helpers - WCAG 2.2 relative luminance and ratio. */

/** Parse `rgb()`, `rgba()`, `#rgb`, `#rrggbb` into { r, g, b, a }. */
export function parseColor(text) {
  if (!text || typeof text !== 'string') return null;
  const value = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = digits.split('').map((d) => parseInt(d + d, 16));
      const a = digits.length === 4 ? parseInt(digits[3] + digits[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!fn) return null;
  // CSS Color 4 allows `rgb(12 34 56 / 25%)` alongside the comma form, and
  // alpha may be a percentage. Splitting on commas, slashes and whitespace
  // handles both; the alpha token is parsed after stripping a trailing `%`.
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map(Number);
  if (rgb.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  let a = 1;
  if (parts.length > 3) {
    const raw = parts[3];
    const percent = raw.endsWith('%');
    const parsed = Number(percent ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(parsed)) return null;
    a = percent ? parsed / 100 : parsed;
  }
  if (a < 0 || a > 1) return null;
  return { r: rgb[0], g: rgb[1], b: rgb[2], a };
}

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance(color) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Composite a possibly translucent foreground over an opaque background. */
export function flatten(fg, bg) {
  const a = fg.a == null ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** WCAG contrast ratio, 1..21. Returns null when a colour cannot be parsed. */
export function contrastRatio(foreground, background) {
  const fg = typeof foreground === 'string' ? parseColor(foreground) : foreground;
  const bg = typeof background === 'string' ? parseColor(background) : background;
  if (!fg || !bg) return null;
  const solidFg = flatten(fg, bg);
  const l1 = relativeLuminance(solidFg);
  const l2 = relativeLuminance(bg);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

/** The AA threshold for a given text size (large text is 18.66px bold / 24px). */
export function aaThreshold({ large = false, nonText = false } = {}) {
  if (nonText) return 3;
  return large ? 3 : 4.5;
}

// --------------------------------------------------------------------- names

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton',
  'textbox', 'combobox', 'searchbox', 'treeitem',
]);

/**
 * Roles whose accessible name is allowed to come from their contents (the
 * ARIA "name from content" rule). Everything else - a main landmark, a list, a
 * paragraph - has no name unless the author provides one, and rendering its
 * whole subtree text as its name would both misdescribe the tree and leak
 * text from aria-hidden descendants.
 */
const NAME_FROM_CONTENT = new Set([
  'button', 'link', 'heading', 'cell', 'gridcell', 'columnheader', 'rowheader',
  'option', 'tab', 'treeitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'checkbox', 'radio', 'switch', 'tooltip',
]);

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button', 'input', 'select', 'textarea', 'summary',
  'iframe', 'object', 'embed', 'audio[controls]', 'video[controls]',
  '[contenteditable]', '[tabindex]',
].join(',');

/** Every element the keyboard can reach, in DOM order. */
export function focusables(root) {
  if (!root || !root.querySelectorAll) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) => {
    if (node.disabled) return false;
    if (node.getAttribute('tabindex') === '-1') return false;
    if (node.tagName === 'INPUT' && node.type === 'hidden') return false;
    return true;
  });
}

/** The keyboard order the browser will actually use: positive tabindex first. */
export function tabOrder(root) {
  const withIndex = focusables(root).map((node, i) => {
    const raw = node.getAttribute('tabindex');
    const tabindex = raw == null ? 0 : Number(raw);
    return { node, tabindex: Number.isFinite(tabindex) ? tabindex : 0, i };
  });
  return withIndex
    .sort((a, b) => {
      const pa = a.tabindex > 0 ? a.tabindex : Infinity;
      const pb = b.tabindex > 0 ? b.tabindex : Infinity;
      return pa === pb ? a.i - b.i : pa - pb;
    })
    .map((entry) => entry.node);
}

/** The accessible name an element exposes, following the ARIA name order. */
export function accessibleName(node) {
  if (!node || node.nodeType !== 1) return '';
  const labelledby = node.getAttribute('aria-labelledby');
  if (labelledby) {
    const root = node.ownerDocument || node;
    const text = labelledby
      .split(/\s+/)
      .map((id) => {
        const ref = root.getElementById ? root.getElementById(id) : null;
        return ref ? ref.textContent : '';
      })
      .join(' ')
      .trim();
    if (text) return text;
  }
  const label = node.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();
  if (node.tagName === 'IMG' && node.getAttribute('alt')) return node.getAttribute('alt').trim();
  if (node.labels && node.labels.length) {
    const text = [...node.labels].map((l) => l.textContent).join(' ').trim();
    if (text) return text;
  }
  if (node.title && node.title.trim()) return node.title.trim();
  const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
  return text;
}

/** The implicit ARIA role of an element, for the tree rendering. */
export function implicitRole(node) {
  const explicit = node.getAttribute && node.getAttribute('role');
  if (explicit) return explicit;
  const tag = (node.tagName || '').toLowerCase();
  const map = {
    a: node.hasAttribute('href') ? 'link' : 'generic',
    article: 'article', aside: 'complementary', button: 'button', canvas: 'img',
    details: 'group', dialog: 'dialog', fieldset: 'group', figure: 'figure',
    footer: 'contentinfo', form: 'form', h1: 'heading', h2: 'heading',
    h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    header: 'banner', img: 'img', input: 'textbox', li: 'listitem',
    main: 'main', nav: 'navigation', ol: 'list', option: 'option',
    p: 'paragraph', pre: 'generic', section: 'region', select: 'combobox',
    summary: 'button', table: 'table', td: 'cell', textarea: 'textbox',
    th: 'columnheader', tr: 'row', ul: 'list',
  };
  if (tag === 'input') {
    const type = (node.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  }
  return map[tag] || 'generic';
}

/** True when an element is reachable by assistive technology. */
export function exposedToAt(node) {
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
    if (n.getAttribute('aria-hidden') === 'true') return false;
    if (n.hasAttribute('hidden')) return false;
  }
  return true;
}

// --------------------------------------------------------------------- audit

const RULES = [
  { id: 'landmark-main', level: 'error', wcag: '1.3.1', description: 'The page has exactly one main landmark' },
  { id: 'heading-order', level: 'warn', wcag: '1.3.1', description: 'Heading levels do not skip' },
  { id: 'control-name', level: 'error', wcag: '4.1.2', description: 'Every focusable control has an accessible name' },
  { id: 'img-alt', level: 'error', wcag: '1.1.1', description: 'Every image declares alternative text' },
  { id: 'canvas-alternative', level: 'error', wcag: '1.1.1', description: 'Every canvas has a text alternative' },
  { id: 'tabindex', level: 'error', wcag: '2.4.3', description: 'No positive tabindex (it breaks the visual order)' },
  { id: 'hidden-focusable', level: 'error', wcag: '4.1.2', description: 'Nothing focusable is hidden from assistive technology' },
  { id: 'live-region', level: 'error', wcag: '4.1.3', description: 'Live regions use a valid politeness value' },
  { id: 'document-lang', level: 'warn', wcag: '3.1.1', description: 'The document declares its language' },
  { id: 'button-type', level: 'warn', wcag: '1.3.1', description: 'Buttons inside a form declare their type' },
];

const NOT_CHECKED = [
  'reading order against the visual order in a real screen reader',
  'focus visibility on every browser (only the CSS contract is asserted)',
  'screen-reader announcements (needs NVDA or VoiceOver on a real session)',
  'touch target size at every zoom level',
];

/** Short, stable description of an element for a finding. */
function describeNode(node) {
  if (!node) return '(missing)';
  const tag = (node.tagName || 'node').toLowerCase();
  const id = node.id ? `#${node.id}` : '';
  const cls = typeof node.className === 'string' && node.className
    ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  const name = accessibleName(node).slice(0, 40);
  return `<${tag}${id}${cls}>${name ? ` "${name}"` : ''}`;
}

/**
 * Audit `root` against the rules above.
 *
 * @param {Document|Element} root
 * @returns {{ findings: Array, rules: Array, notChecked: string[], stats: object }}
 */
export function auditTree(root) {
  const doc = root && root.ownerDocument ? root.ownerDocument : root;
  const findings = [];
  const add = (rule, node, message) => {
    const meta = RULES.find((r) => r.id === rule);
    findings.push({
      rule,
      level: meta ? meta.level : 'warn',
      wcag: meta ? meta.wcag : '',
      target: describeNode(node),
      message,
    });
  };

  const scope = root && root.querySelectorAll ? root : doc;
  if (!scope || !scope.querySelectorAll) {
    return { findings: [{ rule: 'document', level: 'error', wcag: '', target: '(none)', message: 'nothing to audit' }], rules: RULES, notChecked: NOT_CHECKED, stats: { elements: 0, focusable: 0 } };
  }

  // Landmarks
  const mains = [...scope.querySelectorAll('main, [role="main"]')];
  if (mains.length !== 1) add('landmark-main', mains[0] || null, `found ${mains.length} main landmarks, expected 1`);

  // Heading order. A document is read as if an h1 came before its first
  // heading, so a page that opens at h4 is a jump (axe's sibling rule
  // `page-has-heading-one` covers the missing h1 separately; this one is about
  // the sequence after it). `previous = 1` encodes that convention.
  const headings = [...scope.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .filter((h) => exposedToAt(h));
  let previous = 1;
  for (const heading of headings) {
    const ariaLevel = Number(heading.getAttribute('aria-level'));
    const level = Number.isFinite(ariaLevel) && ariaLevel > 0
      ? ariaLevel
      : Number(heading.tagName.slice(1)) || 0;
    if (previous && level > previous + 1) {
      add('heading-order', heading, `jumped from h${previous} to h${level}`);
    }
    previous = level;
  }

  // Named controls
  const reachable = focusables(scope);
  for (const node of reachable) {
    const role = implicitRole(node);
    const tag = (node.tagName || '').toLowerCase();
    const needsName = INTERACTIVE_ROLES.has(role)
      || tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea'
      || (tag === 'input' && node.type !== 'hidden');
    if (!needsName) continue;
    if (role === 'generic') continue;
    if (!accessibleName(node)) add('control-name', node, 'focusable control has no accessible name');
  }

  // Images
  for (const img of scope.querySelectorAll('img')) {
    if (!exposedToAt(img)) continue;
    if (!img.hasAttribute('alt')) add('img-alt', img, 'img has no alt attribute');
  }

  // Canvas
  for (const canvas of scope.querySelectorAll('canvas')) {
    const named = canvas.getAttribute('aria-label') || canvas.getAttribute('aria-labelledby')
      || canvas.getAttribute('aria-describedby') || canvas.getAttribute('role');
    if (!named) add('canvas-alternative', canvas, 'canvas has no aria-label, aria-describedby or role');
  }

  // Positive tabindex
  for (const node of reachable) {
    const raw = node.getAttribute('tabindex');
    if (raw != null && Number(raw) > 0) add('tabindex', node, `tabindex="${raw}" overrides the document order`);
  }

  // Hidden but focusable
  for (const node of reachable) {
    if (!exposedToAt(node)) add('hidden-focusable', node, 'focusable element is aria-hidden or hidden');
  }

  // Live regions
  for (const node of scope.querySelectorAll('[aria-live]')) {
    const value = (node.getAttribute('aria-live') || '').toLowerCase();
    if (!['polite', 'assertive', 'off'].includes(value)) {
      add('live-region', node, `aria-live="${value}" is not a valid politeness value`);
    }
  }

  // Document language
  const html = doc && doc.documentElement;
  if (html) {
    const lang = html.getAttribute('lang');
    if (!lang || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) {
      add('document-lang', html, `lang="${lang || ''}" is missing or malformed`);
    }
  }

  // Buttons inside a form
  for (const button of scope.querySelectorAll('form button:not([type])')) {
    add('button-type', button, 'button inside a form has no type, so it submits');
  }

  const checked = RULES.length;
  const failed = new Set(findings.map((f) => f.rule));
  return {
    findings,
    rules: RULES,
    notChecked: NOT_CHECKED,
    stats: {
      elements: scope.querySelectorAll('*').length,
      focusable: reachable.length,
      checked,
      failed: failed.size,
      passed: checked - failed.size,
      errors: findings.filter((f) => f.level === 'error').length,
      warnings: findings.filter((f) => f.level === 'warn').length,
    },
  };
}

// -------------------------------------------------------------- parallel tree

/**
 * The accessibility tree as text: one line per element, indented, with role,
 * name and state. This is the document-level counterpart to the 3D scene's
 * `describeScene()` text alternative.
 *
 * @param {Element} root
 * @param {{maxDepth?: number, maxNodes?: number}} [options]
 */
export function parallelTextTree(root, options = {}) {
  const maxDepth = options.maxDepth == null ? 12 : options.maxDepth;
  const maxNodes = options.maxNodes == null ? 400 : options.maxNodes;
  const lines = [];
  let count = 0;
  let truncated = false;

  const walk = (node, depth) => {
    if (count >= maxNodes) { truncated = true; return; }
    if (depth > maxDepth) { truncated = true; return; }
    if (!exposedToAt(node)) return;
    const role = implicitRole(node);
    const authored = node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby')
      || node.hasAttribute('title') || (node.tagName === 'IMG' && node.hasAttribute('alt'))
      || (node.labels && node.labels.length > 0);
    const name = (authored || NAME_FROM_CONTENT.has(role)) ? accessibleName(node).slice(0, 60) : '';
    const state = [];
    if (node.disabled) state.push('disabled');
    if (node.getAttribute('aria-expanded')) state.push(`expanded=${node.getAttribute('aria-expanded')}`);
    if (node.getAttribute('aria-selected') === 'true') state.push('selected');
    if (node.getAttribute('aria-checked')) state.push(`checked=${node.getAttribute('aria-checked')}`);
    if (node.getAttribute('aria-live')) state.push(`live=${node.getAttribute('aria-live')}`);
    if (role === 'heading') state.push(node.tagName.toLowerCase());
    const prefix = '  '.repeat(depth);
    lines.push(`${prefix}${role}${name ? ` "${name}"` : ''}${state.length ? ` [${state.join(', ')}]` : ''}`);
    count += 1;
    for (const child of node.children || []) walk(child, depth + 1);
  };

  if (root && root.nodeType === 1) walk(root, 0);
  else if (root && root.body) walk(root.body, 0);
  if (truncated) lines.push(`… truncated at ${maxNodes} nodes / depth ${maxDepth}`);
  return lines.join('\n');
}
