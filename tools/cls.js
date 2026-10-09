/**
 * Layout stability, measured directly (tools/cls.js).
 *
 *   node tools/cls.js                 # this build -> docs/reports/cls.json
 *   node tools/cls.js --out=docs/reports/cls-legacy.json   # any other label
 *
 * Lighthouse reports one CLS number for one load. This tool asks the narrower
 * question that the fix was about: does the page shift when the mobile visual
 * viewport changes size - the URL bar collapsing or expanding, which is what
 * produced the app's 1.000 mobile CLS. It installs a `layout-shift`
 * PerformanceObserver before first paint, loads the page at a phone viewport,
 * then resizes the layout viewport twice and reports the shifts and their
 * culprit nodes.
 *
 * The before/after pair in LOAD_CHAOS.md comes from this same file: the pre-fix
 * rule (percentage insets instead of the transform) was restored in
 * styles/app.css for one run and reverted immediately after, so both numbers
 * come from the same tool, browser and machine rather than from notes taken a
 * week apart.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const args = parseArgs();
const PORT = Number(args.port || 5231);
const OUT = String(args.out || 'docs/reports/cls.json');
const LABEL = String(args.label || (OUT.includes('legacy') ? 'pre-fix rule restored in styles/app.css' : 'current build'));
const WIDTH = 412;
const HEIGHT = 915;
const SHORT = 780;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { proc, origin } = await startProjectServer({ port: PORT });
const browser = await Browser.launch({ width: WIDTH, height: HEIGHT, scale: 2 });
const page = await browser.newSession('about:blank');
const report = {
  measuredAt: new Date().toISOString(),
  url: origin + '/',
  viewport: { width: WIDTH, height: HEIGHT, shrunk: SHORT, mobile: true },
  label: LABEL,
  note: 'layout-shift PerformanceObserver installed before first paint; the layout viewport is resized twice to imitate the mobile URL bar moving',
  steps: [],
};

const observer = `
  window.__shifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        window.__shifts.push({
          value: entry.value,
          sources: (entry.sources || []).map((s) => {
            const n = s.node;
            return n ? n.nodeName + (n.className ? '.' + String(n.className).trim().split(/\\s+/).join('.') : '') : 'detached';
          }),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { window.__shifts = [{ error: String(e) }]; }
`;

try {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: observer });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true, screenWidth: WIDTH, screenHeight: HEIGHT,
  });

  await page.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);

  const step = async (label, height) => {
    const geometry = await page.evaluate(`(() => {
      const a = document.querySelector('.fx-aurora');
      if (!a) return null;
      const r = a.getBoundingClientRect();
      const cs = getComputedStyle(a);
      return {
        inset: [cs.top, cs.right, cs.bottom, cs.left],
        transform: cs.transform,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        renderedShareOfViewport: [Math.round((r.width / innerWidth) * 100), Math.round((r.height / innerHeight) * 100)],
        viewport: [innerWidth, innerHeight],
      };
    })()`);
    const shifts = JSON.parse(
      await page.evaluate(`JSON.stringify({ total: (window.__shifts || []).reduce((s, e) => s + (e.value || 0), 0), entries: window.__shifts || [] })`),
    );
    const entry = { label, height, geometry, cls: Math.round(shifts.total * 1000) / 1000, shiftEntries: shifts.entries.slice(0, 6) };
    report.steps.push(entry);
    console.log(`\n# ${label}  (viewport ${height}px tall)`);
    console.log(`  aurora insets ${geometry.inset.join(' ')} | transform ${geometry.transform}`);
    console.log(`  aurora covers ${geometry.renderedShareOfViewport.join('% x ')}% of the viewport`);
    console.log(`  cumulative layout shift so far: ${entry.cls}  (${entry.shiftEntries.length} shift entries)`);
    for (const s of entry.shiftEntries) console.log(`    - ${s.value.toFixed(4)}  ${s.sources.join(', ')}`);
  };

  await step('after load', HEIGHT);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: SHORT, deviceScaleFactor: 2, mobile: true, screenWidth: WIDTH, screenHeight: HEIGHT,
  });
  await sleep(4000);
  await step('after the visual viewport shrank (URL bar appears)', SHORT);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true, screenWidth: WIDTH, screenHeight: HEIGHT,
  });
  await sleep(4000);
  await step('after the visual viewport grew back (URL bar hides)', HEIGHT);

  report.finalCls = report.steps[report.steps.length - 1].cls;
  report.auroraOverflowPreserved = report.steps.every(
    (s) => s.geometry && s.geometry.renderedShareOfViewport[0] >= 135 && s.geometry.renderedShareOfViewport[1] >= 135,
  );
  mkdirSync('docs/reports', { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n# CLS after the viewport changes: ${report.finalCls}`);
  console.log(`# aurora still overflows the viewport by ~40%: ${report.auroraOverflowPreserved}`);
  console.log(`# report -> ${OUT} (${LABEL})`);
  if (report.finalCls > 0.1) process.exitCode = 1;
} finally {
  await browser.close();
  proc.kill();
}
