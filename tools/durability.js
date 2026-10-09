/**
 * How long can an edit be lost? (M6 durability window)
 *
 * "Offline-first, nothing is lost" is easy to claim and easy to test: type,
 * reload after N milliseconds, and see whether the text is still there. This
 * walks N from small to large and reports the first delay at which every edit
 * survives - the honest answer to "how wide is the window where a crash loses
 * work", measured against IndexedDB in a real browser.
 *
 *   node tools/durability.js [--max-ms=8000]
 */
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const args = parseArgs();
const PORT = Number(args.port || 5203);
const MAX_MS = Number(args['max-ms'] || 8000);
const SEL = 'textarea[aria-label^="Collaborative"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function editorTabIndex(session) {
  const tabs = JSON.parse(
    await session.evaluate(`JSON.stringify([...document.querySelectorAll('#tabs button')].map((b) => (b.textContent || '').trim()))`),
  );
  const index = tabs.findIndex((label) => /editor/i.test(label));
  return index < 0 ? 0 : index;
}

async function openEditor(session) {
  await session.send('Page.enable');
  await session.send('Page.navigate', { url: session.origin + '/' });
  await session.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
  await sleep(2500);
  const tab = await editorTabIndex(session);
  await session.evaluate(`document.querySelectorAll('#tabs button')[${tab}].click()`);
  await sleep(1200);
}

async function main() {
  const delays = [0, 100, 250, 500, 1000, 2000, 4000, MAX_MS].filter((v, i, a) => v <= MAX_MS && a.indexOf(v) === i);
  const { proc, origin } = await startProjectServer({ port: PORT });
  const browser = await Browser.launch({ width: 1280, height: 900, scale: 1 });
  const results = [];
  try {
    for (const delay of delays) {
      const session = await browser.newSession(origin + '/');
      session.origin = origin;
      try {
        await openEditor(session);
        // A fresh marker per attempt, so a stale document cannot fake a pass.
        const marker = `DUR-${delay}-${Date.now()}`;
        await session.evaluate(`document.querySelector('${SEL}').focus()`);
        await session.send('Input.insertText', { text: '\n' + marker });
        await sleep(delay);
        await session.send('Page.reload');
        await session.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
        await sleep(2500);
        const tab = await editorTabIndex(session);
        await session.evaluate(`document.querySelectorAll('#tabs button')[${tab}].click()`);
        await sleep(1200);
        const text = await session.evaluate(`(document.querySelector('${SEL}') || {}).value || ''`);
        const survived = text.includes(marker);
        results.push({ reloadAfterMs: delay, survived });
        console.log(`  reloaded ${String(delay).padStart(5)} ms after the edit: ${survived ? 'edit survived' : 'EDIT LOST'}`);
      } finally {
        await session.closeTab();
      }
    }
    const firstSafe = results.find((r) => r.survived);
    const report = {
      measuredAt: new Date().toISOString(),
      url: origin + '/',
      note: 'Each attempt types a unique marker into the M1 editor, reloads after the stated delay, and checks the marker came back from IndexedDB.',
      results,
      firstSurvivingDelayMs: firstSafe ? firstSafe.reloadAfterMs : null,
      allLost: results.every((r) => !r.survived),
    };
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync('docs/reports', { recursive: true });
    writeFileSync('docs/reports/durability.json', JSON.stringify(report, null, 2) + '\n');
    const all = results.every((r) => r.survived);
    console.log(
      all
        ? `# every tested delay kept the edit, including an immediate reload (${results[0].reloadAfterMs} ms)`
        : firstSafe
          ? `# an edit is durable once ~${firstSafe.reloadAfterMs} ms have passed; a reload sooner than that loses it`
          : '# no delay in the tested range kept the edit',
    );
  } finally {
    await browser.close();
    proc.kill();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  },
);
