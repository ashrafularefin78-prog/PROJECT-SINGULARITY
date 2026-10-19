/**
 * Accessibility audit, run against the app as it really ships.
 *
 *   node tools/a11y.js
 *
 * Three layers, because they catch different things:
 *
 *   1. axe-core (the engine Lighthouse uses for its accessibility category) run
 *      in the page against the WCAG 2.1 A/AA rule set.
 *   2. The browser's own accessibility tree - what a screen reader is actually
 *      handed - checked for interactive controls with no accessible name,
 *      images with no alternative, heading level jumps and a missing language.
 *   3. A text-shaping probe: does the editor's font have real glyphs for Bangla
 *      and Arabic, does multi-byte text survive a real insertion and a reload
 *      (the CRDT + IndexedDB round trip), and is the direction handling sane.
 *
 * What this cannot do is run NVDA or VoiceOver: there is no screen reader on a
 * headless CI machine. The AX-tree pass is the closest honest substitute - it
 * audits the same tree a screen reader consumes - and the report says so.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const args = parseArgs();
const PORT = Number(args.port || 5198);
const OUT_DIR = args['out-dir'] || 'docs/reports';
const AXE = args.axe || '.tools/vendor/axe.min.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'tab',
  'listbox', 'option', 'treeitem', 'gridcell',
]);

/** Roles whose whole purpose is to be announced with a name. */
const NAMED_ROLES = new Set([...INTERACTIVE_ROLES, 'image', 'img', 'figure', 'region', 'heading', 'group', 'tabpanel', 'dialog']);

async function axeAudit(session) {
  const source = readFileSync(AXE, 'utf8');
  await session.send('Page.setBypassCSP', { enabled: true });
  await session.evaluate(source);
  const raw = await session.evaluate(`axe.run(document, {
      resultTypes: ['violations', 'incomplete', 'passes'],
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }
    }).then((r) => JSON.stringify({
      version: (axe.version || 'unknown'),
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        tags: v.tags,
        nodes: v.nodes.slice(0, 8).map((n) => ({
          target: n.target,
          html: String(n.html).slice(0, 160),
          summary: String(n.failureSummary || '').slice(0, 300),
        })),
        count: v.nodes.length,
      })),
      incomplete: r.incomplete.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        count: v.nodes.length,
        targets: v.nodes.slice(0, 6).map((n) => n.target),
      })),
      passCount: r.passes.length,
    }))`);
  return JSON.parse(raw);
}

async function axTreeAudit(session) {
  const { nodes } = await session.send('Accessibility.getFullAXTree');
  const rows = nodes.map((n) => ({
    role: n.role && n.role.value,
    name: (n.name && n.name.value ? String(n.name.value) : '').trim(),
    ignored: !!n.ignored,
    properties: Object.fromEntries((n.properties || []).map((p) => [p.name, p.value && p.value.value])),
    nodeId: n.nodeId,
  }));
  const live = rows.filter((r) => !r.ignored);
  const unnamed = live.filter((r) => INTERACTIVE_ROLES.has(r.role) && !r.name);
  const unnamedOther = live.filter((r) => (r.role === 'image' || r.role === 'img') && !r.name);
  const headings = live.filter((r) => r.role === 'heading').map((r) => ({ name: r.name, level: r.properties.level }));
  const levelJumps = [];
  let previous = 0;
  for (const h of headings) {
    if (previous && h.level && h.level - previous > 1) levelJumps.push({ from: previous, to: h.level, name: h.name });
    previous = h.level || previous;
  }
  const landmarks = live.filter((r) => ['main', 'navigation', 'banner', 'contentinfo', 'region', 'search'].includes(r.role)).map((r) => r.role);
  return {
    totalNodes: rows.length,
    liveNodes: live.length,
    ignoredNodes: rows.length - live.length,
    interactiveCount: live.filter((r) => INTERACTIVE_ROLES.has(r.role)).length,
    unnamedInteractive: unnamed.slice(0, 20),
    unnamedImages: unnamedOther.slice(0, 10),
    headings,
    headingLevelJumps: levelJumps,
    landmarks,
    liveRegions: live.filter((r) => r.properties.live && r.properties.live !== 'off').map((r) => ({ role: r.role, name: r.name, politeness: r.properties.live })),
  };
}

/** Does the rendered text actually draw glyphs, and does it survive a round trip? */
async function shapingProbe(session) {
  const style = JSON.parse(
    await session.evaluate(`(() => {
      const ta = document.querySelector('textarea[aria-label^="Collaborative"]') || document.body;
      const cs = getComputedStyle(ta);
      const font = (cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily).trim();
      const samples = { latin: 'Hello, world', bangla: '\\u09ac\\u09be\\u0982\\u09b2\\u09be', arabic: '\\u0627\\u0644\\u0639\\u0631\\u0628\\u064a\\u0629', mixed: 'code \\u09ac\\u09be\\u0982\\u09b2\\u09be 42' };
      const measure = (text) => {
        const c = document.createElement('canvas');
        c.width = 420; c.height = 80;
        const g = c.getContext('2d');
        g.font = font;
        g.textBaseline = 'top';
        g.fillStyle = '#fff';
        g.fillText(text, 4, 4);
        const data = g.getImageData(0, 0, 420, 80).data;
        let inkPixels = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) inkPixels++;
        return { width: Math.round(g.measureText(text).width * 100) / 100, inkPixels };
      };
      const out = { font, fontFamily: cs.fontFamily, direction: cs.direction, unicodeBidi: cs.unicodeBidi, textAlign: cs.textAlign, htmlLang: document.documentElement.lang, htmlDir: document.documentElement.dir, samples: {} };
      for (const [key, text] of Object.entries(samples)) out.samples[key] = measure(text);
      // Ligature sanity: Arabic words join into fewer, wider clusters than the
      // same letters written separately, so the shaped width must differ.
      out.arabicJoined = measure('\\u0645\\u0631\\u062d\\u0628\\u0627').width;
      out.arabicIsolated = measure('\\u0645 \\u0631 \\u062d \\u0628 \\u0627').width;
      return JSON.stringify(out);
    })()`),
  );

  // End-to-end: insert multi-byte text where a person would type it, read the
  // editor back, then reload and read it again - CRDT, storage and rebuild.
  const SAMPLE = '\u09ac\u09be\u0982\u09b2\u09be \u0627\u0644\u0639\u0631\u0628\u064a\u0629 42';
  const selector = 'textarea[aria-label^="Collaborative"]';
  const hasEditor = await session.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  if (!hasEditor) {
    return { ...style, error: 'the collaborative editor textarea was not on the first module tab' };
  }
  const before = await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).value.length`);
  await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await session.send('Input.insertText', { text: SAMPLE });
  await sleep(500);
  const afterInsert = await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
  const survivedInsert = afterInsert.includes(SAMPLE);
  const codepoints = [...SAMPLE].length;

  await session.send('Page.reload');
  await session.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
  await sleep(2500);
  // The app comes back on the dashboard, so the editor panel has to be opened
  // again before its textarea exists (without this the check reads '' and
  // silently reports "lost", which is a false negative, not a finding).
  const tabsNow = await listTabs(session);
  const editorTab = tabsNow.find((t) => /editor/i.test(t.label)) || tabsNow[0];
  await selectTab(session, editorTab.i);
  await sleep(800);
  const afterReload = await session.evaluate(
    `(document.querySelector(${JSON.stringify(selector)}) || {}).value || ''`,
  );
  return {
    font: style.font,
    direction: style.direction,
    unicodeBidi: style.unicodeBidi,
    htmlLang: style.htmlLang,
    htmlDir: style.htmlDir,
    samples: style.samples,
    arabicShapingLooksApplied: Math.abs(style.arabicJoined - style.arabicIsolated) > 1,
    sample: SAMPLE,
    codepoints,
    beforeLength: before,
    survivedInsert,
    survivedReload: afterReload.includes(SAMPLE),
    afterReloadLength: afterReload.length,
    reloadNote: 'reloaded ~2.5 s after the edit, which is inside the measured durability window (see docs/reports/durability.json)',
  };
}

/** The module tabs, in the order they appear in the tab list. */
async function listTabs(session) {
  const raw = await session.evaluate(`JSON.stringify([...document.querySelectorAll('#tabs button')].map((b, i) => ({ i, label: (b.textContent || '').trim().slice(0, 40) })))`);
  return JSON.parse(raw);
}

async function selectTab(session, index) {
  await session.evaluate(`(() => { const b = document.querySelectorAll('#tabs button')[${index}]; if (b) b.click(); })()`);
  await sleep(1200);
}

/** Fold the per-module axe reports into one list, with the modules named. */
function mergeAxe(reports) {
  const byRule = new Map();
  let passes = 0;
  for (const { module: moduleName, axe } of reports) {
    passes += axe.passCount;
    for (const v of axe.violations) {
      const entry = byRule.get(v.id) || { ...v, nodes: [], modules: [] };
      if (!entry.modules.includes(moduleName)) entry.modules.push(moduleName);
      for (const n of v.nodes) entry.nodes.push({ ...n, module: moduleName });
      entry.count = entry.nodes.length;
      byRule.set(v.id, entry);
    }
  }
  return {
    passes,
    violations: [...byRule.values()].sort((a, b) => b.nodes.length - a.nodes.length),
  };
}

async function main() {
  const { proc, origin } = await startProjectServer({ port: PORT });
  const browser = await Browser.launch({ width: 1280, height: 900, scale: 1 });
  const report = { measuredAt: new Date().toISOString(), url: origin + '/', browser: null, note: 'axe-core plus the browser accessibility tree; not a screen-reader session (none is available headlessly)' };
  try {
    report.browser = (await browser.send('Browser.getVersion')).product;
    const session = await browser.newSession(origin + '/');
    await session.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
    // Let the app finish booting (modules register, panels render).
    await sleep(3000);

    const tabs = await listTabs(session);
    report.tabs = tabs.map((t) => t.label);
    const perModule = [];
    for (const tab of tabs) {
      await selectTab(session, tab.i);
      const axe = await axeAudit(session);
      const axTree = await axTreeAudit(session);
      perModule.push({ module: tab.label || `tab ${tab.i}`, axe, axTree });
    }
    report.perModule = perModule;
    report.axe = { ...mergeAxe(perModule), perModule: perModule.map((m) => ({ module: m.module, violations: m.axe.violations.length, passes: m.axe.passCount, incomplete: m.axe.incomplete.length })) };
    report.axTree = perModule.map((m) => ({
      module: m.module,
      liveNodes: m.axTree.liveNodes,
      interactiveCount: m.axTree.interactiveCount,
      unnamedInteractive: m.axTree.unnamedInteractive,
      unnamedImages: m.axTree.unnamedImages,
      headingLevelJumps: m.axTree.headingLevelJumps,
      headings: m.axTree.headings,
    }));

    // The editor lives in the M1 module; shape the text there. Tab 0 is the
    // dashboard, so the editor tab is found by name.
    const editorTab = tabs.find((t) => /editor/i.test(t.label)) || tabs[1] || tabs[0];
    await selectTab(session, editorTab.i);
    report.shaping = await shapingProbe(session);
    report.shapingTab = editorTab.label;
    report.pageErrors = session.pageErrors.slice(0, 10);
    report.consoleErrors = session.consoleErrors.slice(0, 10);

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/a11y.json`, JSON.stringify(report, null, 2) + '\n');

    console.log(`# Accessibility: ${report.browser} against ${report.url}`);
    console.log(`# modules audited: ${tabs.map((t) => t.label).join(' | ')}`);
    console.log(`# axe-core ${perModule[0] ? (perModule[0].axe.version || '') : ''}: ${report.axe.violations.length} rules violated, ${report.axe.passes} rule results passed`);
    for (const v of report.axe.violations) {
      console.log(`  [${v.impact || 'n/a'}] ${v.id}: ${v.help} - ${v.nodes.length} node(s) in ${v.modules.join(', ')}`);
      for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.module}: ${n.target.join(' ')}  ${n.summary.split('\n')[0]}`);
    }
    const unnamed = report.axTree.flatMap((m) => m.unnamedInteractive.map((n) => ({ ...n, module: m.module })));
    console.log(`# accessibility tree: ${report.axTree.reduce((a, m) => a + m.interactiveCount, 0)} interactive controls across ${tabs.length} modules`);
    console.log(`# interactive controls with no accessible name: ${unnamed.length}`);
    for (const n of unnamed.slice(0, 10)) console.log(`      ${n.module}: role=${n.role}`);
    const jumps = report.axTree.flatMap((m) => m.headingLevelJumps.map((j) => ({ ...j, module: m.module })));
    console.log(`# heading level jumps: ${jumps.length}`);
    const sh = report.shaping;
    console.log(`# shaping: font=${sh.font}`);
    for (const [key, value] of Object.entries(sh.samples)) {
      console.log(`      ${key.padEnd(7)} width ${String(value.width).padStart(7)} px, ink ${value.inkPixels} px`);
    }
    console.log(`# arabic joins into clusters (shaping applied): ${sh.arabicShapingLooksApplied}`);
    console.log(`# multi-byte round trip: inserted=${sh.survivedInsert} survivedReload=${sh.survivedReload} (${sh.codepoints} codepoints)`);
    console.log(`# written to ${OUT_DIR}/a11y.json`);
    await session.closeTab();
  } finally {
    await browser.close();
    proc.kill();
  }
  return report;
}

main().then(
  (report) => {
    const violations = report && report.axe ? report.axe.violations.length : 0;
    if (violations > 0) {
      console.error(`# accessibility gate failed: ${violations} axe-core violation(s)`);
      process.exit(1);
    }
    process.exit(0);
  },
  (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  },
);
