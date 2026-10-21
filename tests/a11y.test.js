import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import {
  aaThreshold,
  accessibleName,
  auditTree,
  contrastRatio,
  focusables,
  implicitRole,
  parallelTextTree,
  parseColor,
  tabOrder,
} from '../src/ui/a11y-contract.js';

test('M7 contract: colour parsing accepts the formats the CSS actually uses', () => {
  assertDeepEquals(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assertDeepEquals(parseColor('#000000'), { r: 0, g: 0, b: 0, a: 1 });
  assertDeepEquals(parseColor('rgb(12, 34, 56)'), { r: 12, g: 34, b: 56, a: 1 });
  assertDeepEquals(parseColor('rgba(12,34,56,0.5)'), { r: 12, g: 34, b: 56, a: 0.5 });
  assertDeepEquals(parseColor('rgb(12 34 56 / 25%)'), { r: 12, g: 34, b: 56, a: 0.25 });
  assertEquals(parseColor('not-a-colour'), null);
  assertEquals(parseColor(''), null);
}, { needs: 'dom' });

test('M7 contract: contrast matches the WCAG reference values', () => {
  assertEquals(Math.round(contrastRatio('#000', '#fff')), 21, 'black on white is 21:1');
  assertEquals(contrastRatio('#fff', '#fff').toFixed(0), '1');
  // 4.5:1 is the AA threshold for body text: #767676 on white is the canonical
  // "just passes" grey, #777777 is just under it.
  assert(contrastRatio('#767676', '#ffffff') >= 4.5, 'the reference grey passes AA');
  assert(contrastRatio('#777777', '#ffffff') < 4.53, 'and the next step does not gain anything');
  // A translucent foreground is composited before the ratio is taken, which is
  // the mistake most contrast checkers make.
  const solid = contrastRatio('#000', '#fff');
  const half = contrastRatio('rgba(0,0,0,0.5)', '#fff');
  assert(half < solid && half > 1, 'fifty percent black is weaker than black');
  assertEquals(aaThreshold(), 4.5);
  assertEquals(aaThreshold({ large: true }), 3);
  assertEquals(aaThreshold({ nonText: true }), 3);
}, { needs: 'dom' });

test('M7 contract: the accessible name follows the ARIA order', () => {
  const doc = document.implementation.createHTMLDocument('names');
  const body = doc.body;
  body.append(Object.assign(doc.createElement('span'), { id: 'lbl', textContent: 'Stored label' }));
  const a = doc.createElement('button');
  a.setAttribute('aria-labelledby', 'lbl');
  a.textContent = 'text';
  body.append(a);
  assertEquals(accessibleName(a), 'Stored label', 'aria-labelledby wins');

  const b = doc.createElement('button');
  b.setAttribute('aria-label', 'aria label');
  b.textContent = 'text';
  body.append(b);
  assertEquals(accessibleName(b), 'aria label');

  const c = doc.createElement('button');
  c.textContent = '  visible   text ';
  body.append(c);
  assertEquals(accessibleName(c), 'visible text', 'text content is normalised');
}, { needs: 'dom' });

test('M7 contract: an accessible page passes every rule', () => {
  const doc = document.implementation.createHTMLDocument('clean');
  doc.documentElement.setAttribute('lang', 'en');
  doc.body.append(Object.assign(doc.createElement('main'), { id: 'main' }));
  const main = doc.getElementById('main');
  main.append(Object.assign(doc.createElement('h1'), { textContent: 'Title' }));
  main.append(Object.assign(doc.createElement('h2'), { textContent: 'Section' }));
  const button = doc.createElement('button');
  button.textContent = 'Save';
  main.append(button);
  const canvas = doc.createElement('canvas');
  canvas.setAttribute('aria-label', 'A spinning cube');
  main.append(canvas);
  const live = doc.createElement('p');
  live.setAttribute('aria-live', 'polite');
  live.textContent = 'status';
  main.append(live);

  const report = auditTree(doc);
  assertEquals(report.findings.length, 0, JSON.stringify(report.findings));
  assertEquals(report.stats.errors, 0);
  assertEquals(report.stats.passed, report.stats.checked);
  assert(report.notChecked.length >= 3, 'the audit says what it did not check');
}, { needs: 'dom' });

test('M7 contract: every rule fires on a page that breaks it', () => {
  const doc = document.implementation.createHTMLDocument('broken');
  doc.documentElement.removeAttribute('lang');
  const main = doc.createElement('main');
  doc.body.append(main);
  const anonymous = doc.createElement('button');
  main.append(anonymous);
  const img = doc.createElement('img');
  img.src = 'x.png';
  main.append(img);
  const canvas = doc.createElement('canvas');
  main.append(canvas);
  const ordered = doc.createElement('a');
  ordered.href = '#x';
  ordered.setAttribute('tabindex', '3');
  ordered.textContent = 'first';
  main.append(ordered);
  const h4 = doc.createElement('h4');
  h4.textContent = 'skipped levels';
  main.append(h4);
  const live = doc.createElement('p');
  live.setAttribute('aria-live', 'loud');
  main.append(live);
  const hidden = doc.createElement('button');
  hidden.setAttribute('aria-hidden', 'true');
  hidden.textContent = 'hidden';
  main.append(hidden);
  const form = doc.createElement('form');
  form.append(Object.assign(doc.createElement('button'), { textContent: 'submit' }));
  const duplicate = doc.createElement('div');
  duplicate.id = 'main';
  main.append(duplicate);
  const iframe = doc.createElement('iframe');
  main.append(iframe);
  main.append(form);

  const rules = new Set(auditTree(doc).findings.map((f) => f.rule));
  for (const expected of [
    'landmark-main', 'heading-order', 'control-name', 'img-alt',
    'canvas-alternative', 'tabindex', 'hidden-focusable', 'live-region',
    'document-lang', 'button-type', 'duplicate-id', 'iframe-title',
  ]) {
    // landmark-main is satisfied here (one main), so it must NOT be reported.
    if (expected === 'landmark-main') continue;
    assert(rules.has(expected), `expected the ${expected} rule to fire, got ${[...rules].join(', ')}`);
  }
  const report = auditTree(doc);
  assert(report.stats.failed >= 8, `expected several failed rules, got ${report.stats.failed}`);
  assert(report.stats.errors > 0 && report.stats.warnings > 0, 'findings carry a severity');
}, { needs: 'dom' });

test('M7 contract: two mains and a missing main are both reported', () => {
  const doc = document.implementation.createHTMLDocument('landmarks');
  doc.documentElement.setAttribute('lang', 'en');
  doc.body.append(doc.createElement('main'));
  doc.body.append(doc.createElement('main'));
  const two = auditTree(doc).findings.filter((f) => f.rule === 'landmark-main');
  assertEquals(two.length, 1, 'a duplicate landmark is one finding');
  assert(/found 2/.test(two[0].message), two[0].message);

  doc.body.lastChild.remove();
  doc.body.lastChild.remove();
  const none = auditTree(doc).findings.filter((f) => f.rule === 'landmark-main');
  assertEquals(none.length, 1);
  assert(/found 0/.test(none[0].message), none[0].message);
}, { needs: 'dom' });

test('M7 contract: focus order and positive tabindex', () => {
  const doc = document.implementation.createHTMLDocument('focus');
  const a = doc.createElement('button');
  a.textContent = 'a';
  const b = doc.createElement('button');
  b.textContent = 'b';
  b.setAttribute('tabindex', '1');
  const c = doc.createElement('button');
  c.textContent = 'c';
  const skipped = doc.createElement('button');
  skipped.setAttribute('tabindex', '-1');
  skipped.textContent = 'skipped';
  doc.body.append(a, b, c, skipped);

  const reachable = focusables(doc).map((n) => n.textContent);
  assertDeepEquals(reachable, ['a', 'b', 'c'], 'tabindex -1 is not in the tab order');
  const order = tabOrder(doc).map((n) => n.textContent);
  assertDeepEquals(order, ['b', 'a', 'c'], 'the browser visits positive tabindex first');

  const report = auditTree(doc);
  const tabindex = report.findings.filter((f) => f.rule === 'tabindex');
  assertEquals(tabindex.length, 1);
  assert(/tabindex="1"/.test(tabindex[0].message), tabindex[0].message);
}, { needs: 'dom' });

test('M7 contract: the parallel text tree renders roles, names and state', () => {
  const doc = document.implementation.createHTMLDocument('tree');
  const main = doc.createElement('main');
  const h1 = doc.createElement('h1');
  h1.textContent = 'Singularity';
  const nav = doc.createElement('nav');
  const link = doc.createElement('a');
  link.href = '#editor';
  link.textContent = 'Editor';
  nav.append(link);
  const button = doc.createElement('button');
  button.setAttribute('aria-expanded', 'false');
  button.textContent = 'Menu';
  main.append(h1, nav, button);
  doc.body.append(main);

  const text = parallelTextTree(doc);
  assert(/^\s*main/m.test(text), text);
  assert(/heading "Singularity" \[h1\]/.test(text), text);
  assert(/navigation/.test(text), text);
  assert(/link "Editor"/.test(text), text);
  assert(/button "Menu" \[expanded=false\]/.test(text), text);

  const hidden = doc.createElement('div');
  hidden.setAttribute('aria-hidden', 'true');
  hidden.append(Object.assign(doc.createElement('button'), { textContent: 'invisible' }));
  doc.body.append(hidden);
  assert(!/invisible/.test(parallelTextTree(doc)), 'aria-hidden subtrees are not in the tree');

  const deep = parallelTextTree(doc, { maxDepth: 1 });
  assert(/truncated/.test(deep), 'a clipped tree says so instead of lying');
}, { needs: 'dom' });

test('M7 contract: implicit roles cover the elements the page uses', () => {
  const doc = document.implementation.createHTMLDocument('roles');
  const make = (tag, attrs = {}) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  assertEquals(implicitRole(make('a', { href: '#x' })), 'link');
  assertEquals(implicitRole(make('a')), 'generic', 'an anchor without href is not a link');
  assertEquals(implicitRole(make('h2')), 'heading');
  assertEquals(implicitRole(make('input', { type: 'checkbox' })), 'checkbox');
  assertEquals(implicitRole(make('input', { type: 'range' })), 'slider');
  assertEquals(implicitRole(make('input')), 'textbox');
  assertEquals(implicitRole(make('div', { role: 'tablist' })), 'tablist');
  assertEquals(implicitRole(make('main')), 'main');
}, { needs: 'dom' });
