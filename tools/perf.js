/**
 * Performance measurements, taken the way the brief asks for them:
 *
 *   node tools/perf.js lcp    throttled LCP: Slow 4G (150 ms RTT, 1.6 Mbps) and
 *                             4x CPU slowdown, mobile viewport, against the
 *                             real dev server (so the shipped CSP/COOP/COEP
 *                             headers are part of the measurement)
 *   node tools/perf.js soak   an N-minute memory soak that samples the JS heap
 *                             after an explicit GC every minute and takes real
 *                             heap snapshots at chosen minutes, then compares
 *                             them by retained bytes per object type
 *
 * Everything is written to docs/reports/*.json so the numbers in LOAD_CHAOS.md
 * can be traced back to a run rather than to somebody's memory of a run.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Browser, parseArgs } from './cdp.js';

/** Kept as an object so the analysis helpers below read like the ones above. */
const require$fs = { readFileSync, readdirSync };
const require$readFileSync = readFileSync;

const args = parseArgs();
const PORT = Number(args.port || 5199);
const OUT_DIR = args['out-dir'] || 'docs/reports';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the app server answers, so a measurement never races startup. */
async function waitForServer(origin, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(origin + '/', { redirect: 'manual' });
      if (res.status < 500) return res;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server at ${origin} did not answer`);
    await sleep(200);
  }
}

/**
 * Boot the project's own dev server, so measurements include the security
 * headers the app actually ships with (a different header set can change both
 * load time and whether a worker is allowed to start).
 */
async function startServer() {
  const proc = spawn(process.execPath, ['tools/serve.js', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The host environment may define PORT (Freebuff sets PORT=0); the port this
    // tool chose is the one the measurements refer to.
    env: { ...process.env, PORT: String(PORT) },
  });
  const origin = `http://127.0.0.1:${PORT}`;
  await waitForServer(origin);
  return { proc, origin };
}

/** PerformanceObserver instrumentation, installed before the document loads. */
const INSTRUMENT = `
  window.__PERF = { lcp: 0, lcpElement: '', fcp: 0, cls: 0, longTasks: 0, longTaskMs: 0, marks: [] };
  const describe = (el) => {
    if (!el) return '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '';
    return el.tagName + (el.id ? '#' + el.id : '') + cls;
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__PERF.lcp = e.startTime;
        window.__PERF.lcpElement = describe(e.element);
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { window.__PERF.lcpError = String(e); }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') window.__PERF.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch (e) { /* paint timing is optional */ }
  try {
    let cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value;
      window.__PERF.cls = cls;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* layout shifts are optional */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__PERF.longTasks += 1;
        window.__PERF.longTaskMs += e.duration;
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* long tasks are optional */ }
`;

const num = (v) => Math.round(Number(v) * 100) / 100;

async function collectMetrics(session, timeoutMs) {
  await session.send('Performance.enable', {}, timeoutMs ? { timeoutMs } : undefined);
  const { metrics } = await session.send('Performance.getMetrics', {}, timeoutMs ? { timeoutMs } : undefined);
  const map = {};
  for (const m of metrics) map[m.name] = m.value;
  return map;
}

// ---------------------------------------------------------------------- lcp

// Lighthouse's "Slow 4G" mobile profile, expressed as CDP network conditions.
const SLOW_4G = {
  offline: false,
  latency: 150,
  downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8),
  uploadThroughput: Math.round((750 * 1024) / 8),
};

async function runProfiledLoad({ browser, origin, profile }) {
  const session = await browser.newSession('about:blank');
  try {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      mobile: profile !== 'unthrottled',
    });
    if (profile === 'slow-4g-4x-cpu') {
      await session.send('Network.enable');
      await session.send('Network.emulateNetworkConditions', { ...SLOW_4G, connectionType: 'cellular4g' });
      await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    } else {
      await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }

    const started = Date.now();
    await session.send('Page.navigate', { url: origin + '/' });
    await session.waitFor('document.readyState === "complete"', { timeoutMs: 120000 });
    // LCP is only final once the page stops painting new candidates.
    await sleep(args['settle-ms'] ? Number(args['settle-ms']) : 6000);
    const perf = JSON.parse(await session.evaluate('JSON.stringify(window.__PERF)'));
    const nav = JSON.parse(
      await session.evaluate(`JSON.stringify((performance.getEntriesByType('navigation')[0] || {}).toJSON
        ? performance.getEntriesByType('navigation')[0].toJSON()
        : {})`),
    );
    const metrics = await collectMetrics(session);
    return {
      profile,
      wallClockMs: Date.now() - started,
      lcpMs: num(perf.lcp),
      lcpElement: perf.lcpElement,
      fcpMs: num(perf.fcp),
      cumulativeLayoutShift: num(perf.cls),
      longTasks: perf.longTasks,
      longTaskMs: num(perf.longTaskMs),
      ttfbMs: num(nav.responseStart),
      domContentLoadedMs: num(nav.domContentLoadedEventEnd),
      loadEventMs: num(nav.loadEventEnd),
      transferBytes: nav.transferSize,
      jsHeapUsedMiB: num((metrics.JSHeapUsedSize || 0) / 1048576),
      nodes: metrics.Nodes,
      layoutCount: metrics.LayoutCount,
      recalcStyleCount: metrics.RecalcStyleCount,
      taskDurationMs: num((metrics.TaskDuration || 0) * 1000),
    };
  } finally {
    await session.closeTab();
  }
}

async function lcpReport() {
  const { proc, origin } = await startServer();
  const browser = await Browser.launch({ width: 412, height: 915, scale: 2 });
  try {
    const runs = [];
    for (let i = 0; i < (args.repeat ? Number(args.repeat) : 2); i += 1) {
      runs.push(await runProfiledLoad({ browser, origin, profile: 'slow-4g-4x-cpu' }));
      runs.push(await runProfiledLoad({ browser, origin, profile: 'unthrottled' }));
    }
    const throttled = runs.filter((r) => r.profile === 'slow-4g-4x-cpu');
    const warm = runs.filter((r) => r.profile === 'unthrottled');
    const report = {
      measuredAt: new Date().toISOString(),
      conditions: {
        viewport: '412x915 @2.625 (mobile)',
        throttled: 'CDP Slow 4G: 150 ms RTT, 1.6 Mbps down, 750 Kbps up; 4x CPU slowdown',
        unthrottled: 'no network or CPU throttling (loopback reference)',
        server: 'tools/serve.js with the production security headers',
        lcpSource: 'PerformanceObserver largest-contentful-paint (buffered)',
      },
      slow4g4xcpu: throttled,
      unthrottled: warm,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/lcp.json`, JSON.stringify(report, null, 2) + '\n');

    const fmt = (r) =>
      `${String(r.profile).padEnd(14)} LCP ${String(r.lcpMs).padStart(8)} ms  ` +
      `FCP ${String(r.fcpMs).padStart(7)} ms  TTFB ${String(r.ttfbMs).padStart(7)} ms  ` +
      `CLS ${String(r.cumulativeLayoutShift).padStart(5)}  long tasks ${r.longTasks} (${r.longTaskMs} ms)  ` +
      `heap ${r.jsHeapUsedMiB} MiB  element ${r.lcpElement}`;
    console.log('# Throttled LCP (Slow 4G, 4x CPU, 412x915 mobile)');
    for (const r of runs) console.log('  ' + fmt(r));
    console.log(`\nwritten to ${OUT_DIR}/lcp.json`);
  } finally {
    await browser.close();
    proc.kill();
  }
}

// --------------------------------------------------------------------- soak

/**
 * Turn a .heapsnapshot into "where did the bytes go": total self size and count
 * per object type and constructor name. Comparing two of these answers the only
 * question a soak is asked - is anything growing that should not be.
 */
function summariseSnapshot(raw) {
  const snap = JSON.parse(raw);
  // V8 puts the field description under `snapshot.meta` (older dumps put it at
  // the top level), and the arrays beside it.
  const meta = (snap.snapshot && snap.snapshot.meta) || snap.meta;
  if (!meta) throw new Error('heap snapshot has no meta section - the chunk stream was incomplete');
  const { nodes, strings } = snap;
  const fields = meta.node_fields;
  const types = meta.node_types[fields.indexOf('type')];
  const stride = fields.length;
  const selfIdx = fields.indexOf('self_size');
  const typeIdx = fields.indexOf('type');
  const nameIdx = fields.indexOf('name');
  const idIdx = fields.indexOf('id');
  const byType = new Map();
  const byName = new Map();
  let total = 0;
  let live = 0;
  for (let i = 0; i < nodes.length; i += stride) {
    const size = nodes[i + selfIdx];
    const typeName = types[nodes[i + typeIdx]];
    const name = strings[nodes[i + nameIdx]] || '(anonymous)';
    total += size;
    byType.set(typeName, (byType.get(typeName) || 0) + size);
    if (typeName !== 'hidden' && typeName !== 'synthetic') {
      const key = `${typeName} ${name}`;
      const entry = byName.get(key) || { bytes: 0, count: 0 };
      entry.bytes += size;
      entry.count += 1;
      byName.set(key, entry);
      live += size;
    }
  }
  const top = [...byName.entries()]
    .map(([name, entry]) => ({ name, bytes: entry.bytes, count: entry.count }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20);
  return {
    nodeCount: nodes.length / stride,
    totalSelfBytes: total,
    reachableBytes: live,
    byType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
    topRetained: top,
    nodeIdCount: idIdx >= 0 ? nodes.filter((_, i) => i % stride === idIdx).length : 0,
  };
}

async function takeSnapshot(session, dir, label) {
  await session.send('HeapProfiler.enable');
  const chunks = [];
  const collect = (params) => chunks.push(params.chunk);
  session.on('HeapProfiler.addHeapSnapshotChunk', collect);
  await session.send('HeapProfiler.collectGarbage');
  await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, { timeoutMs: 600000 });
  const raw = chunks.join('');
  writeFileSync(`${dir}/heap-${label}.heapsnapshot`, raw);
  return { label, file: `${dir}/heap-${label}.heapsnapshot`, bytes: raw.length, summary: summariseSnapshot(raw) };
}

/**
 * Generous per-call budget for the soak's CDP calls. A soak drives a live app
 * whose main thread is busy on purpose (software-GL frames between module
 * switches), so a slow answer is expected and must not be mistaken for a
 * failure. Without this the earlier 60-minute run died at minute 24 on a plain
 * `Runtime.evaluate` timeout after 30 s.
 */
const SOAK_EVAL_TIMEOUT = 180000;

async function soakReport() {
  const minutes = Number(args.minutes || 60);
  const snapshotMinutes = String(args['snapshot-at'] || '10,60')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => n > 0 && n <= minutes);
  const { proc, origin } = await startServer();
  const rawDir = '.tools/soak';
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });  const browser = await Browser.launch({ width: 1440, height: 900, scale: 1 });
  const product0 = (await browser.send('Browser.getVersion')).product;
  const session = await browser.newSession(origin + '/');
  const samples = [];
  const snapshots = [];
  try {
    await session.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
    const startedAt = Date.now();
    const samplePath = `${rawDir}/samples.jsonl`;
    writeFileSync(samplePath, '');
    const totalMinutes = Math.max(1, Math.round(minutes));
    console.log(`# Memory soak: ${totalMinutes} minute(s) against ${origin}/`);
    console.log(`# samples -> ${samplePath}, snapshots at minutes ${snapshotMinutes.join(', ') || '(none)'}`);

    // Rotate through the modules, one per minute: every panel builds its own
    // DOM (canvases, workers, observers) and tears it down again, which is the
    // realistic leak path - an idle page proves much less.
    //
    // The shell creates its tabs asynchronously after load, so wait for them.
    // Without this wait a soak started on a slow boot samples an empty tab strip
    // and then idles for its whole duration, which is a silently worthless
    // measurement (this happened: "rotating through 0 module tabs").
    await session.waitFor('document.querySelectorAll("#tabs button").length > 0', {
      timeoutMs: 90000,
    });
    const tabLabels = JSON.parse(
      await session.evaluate(
        `JSON.stringify([...document.querySelectorAll('#tabs button')].map((b) => (b.textContent || '').trim().slice(0, 30)))`,
        { timeoutMs: SOAK_EVAL_TIMEOUT },
      ),
    );
    console.log(`# rotating through ${tabLabels.length} module tabs`);

    // A soak that dies halfway must still produce its evidence: the samples so
    // far are real data, and `writeSoakReport` is called from the failure path
    // too. `interrupted` is reported in the artifact so a partial run can never
    // be mistaken for a complete one.
    let interrupted = null;
    for (let minute = 1; minute <= totalMinutes; minute += 1) {
      try {
      await sleep(60000);
      const tabIndex = (minute - 1) % Math.max(1, tabLabels.length);
      await session.evaluate(
        `(() => { const b = document.querySelectorAll('#tabs button')[${tabIndex}]; if (b) b.click(); })()`,
        { timeoutMs: SOAK_EVAL_TIMEOUT },
      );
      await sleep(1500);
      await session.send('HeapProfiler.enable', {}, { timeoutMs: SOAK_EVAL_TIMEOUT });
      await session.send('HeapProfiler.collectGarbage', {}, { timeoutMs: SOAK_EVAL_TIMEOUT });
      const usage = await session.send('Runtime.getHeapUsage', {}, { timeoutMs: SOAK_EVAL_TIMEOUT });
      const metrics = await collectMetrics(session, SOAK_EVAL_TIMEOUT);
      const dom = JSON.parse(
        await session.evaluate(
          `JSON.stringify({
             elements: document.getElementsByTagName('*').length,
             canvases: document.getElementsByTagName('canvas').length,
             heapMiB: (performance.memory ? performance.memory.usedJSHeapSize : 0) / 1048576,
             visibility: document.visibilityState
           })`,
          { timeoutMs: SOAK_EVAL_TIMEOUT },
        ),
      );
      const sample = {
        minute,
        elapsedMs: Date.now() - startedAt,
        jsHeapUsedMiB: num(usage.usedSize / 1048576),
        jsHeapTotalMiB: num(usage.totalSize / 1048576),
        jsHeapUsedMiBPerfMemory: num(dom.heapMiB),
        nodes: metrics.Nodes,
        documents: metrics.Documents,
        layoutCount: metrics.LayoutCount,
        domElements: dom.elements,
        canvases: dom.canvases,
        module: tabLabels[tabIndex] || null,
      };
      samples.push(sample);
      appendFileSync(samplePath, JSON.stringify(sample) + '\n');
      // Keep the analysis current, so a soak stopped early still reports.
      if (minute % 5 === 0) writeSoakReport({ samples, snapshots, browserProduct: product0 });
      console.log(
        `  minute ${String(minute).padStart(2)}  JS heap after GC ${String(sample.jsHeapUsedMiB).padStart(7)} MiB` +
          `  nodes ${String(sample.nodes).padStart(7)}  DOM ${String(sample.domElements).padStart(5)}` +
          `  module ${sample.module || '-'}`,
      );

      if (snapshotMinutes.includes(minute)) {
        const snap = await takeSnapshot(session, rawDir, `${minute}m`);
        snapshots.push(snap);
        console.log(
          `         heap snapshot at ${minute}m: ${snap.summary.nodeCount} nodes, ` +
            `${(snap.summary.reachableBytes / 1048576).toFixed(2)} MiB reachable -> ${snap.file}`,
        );
      }
      // A soak of a live app should keep the app live: a resize forces the
      // renderer to re-create its drawing buffer, which is a common leak path.
      await session.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: 1280 + (minute % 2) * 96,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        },
        { timeoutMs: SOAK_EVAL_TIMEOUT },
      );
      } catch (err) {
        // Never lose the samples: record where it stopped, keep what was
        // measured, and report the interruption instead of throwing it away.
        interrupted = { minute, reason: err && err.message ? err.message : String(err) };
        console.error(`# soak interrupted at minute ${minute}: ${interrupted.reason}`);
        break;
      }
    }
    if (interrupted) process.exitCode = 1;

    // Write the analysis after the loop, and again if more samples arrive.
    let product = product0;
    try {
      product = (await browser.send('Browser.getVersion', {}, { timeoutMs: 30000 })).product;
    } catch {
      /* the browser may be the thing that died - the samples still stand */
    }
    writeSoakReport({ samples, snapshots, browserProduct: product, interrupted });
  } finally {
    await browser.close();
    proc.kill();
  }
}

/** The soak report, written from whatever samples exist (also usable after a restart). */
function writeSoakReport({ samples, snapshots, browserProduct, snapshotFiles = [], interrupted = null }) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const peak = samples.reduce((a, b) => (b.jsHeapUsedMiB > a.jsHeapUsedMiB ? b : a), samples[0]);
  const summaries = snapshots.length
    ? snapshots
    : snapshotFiles.map((file) => ({
        label: (/(\d+)m\.heapsnapshot$/.exec(file) || [])[1] || 'unknown',
        file,
        bytes: 0,
        summary: summariseSnapshot(require$readFileSync(file, 'utf8')),
      }));
  const ordered = summaries.slice().sort((a, b) => parseInt(a.label, 10) - parseInt(b.label, 10));
  const report = {
    measuredAt: new Date().toISOString(),
    minutes: samples.length,
    browser: browserProduct || null,
    samples,
    // `interrupted` is null for a complete run. A partial run says exactly
    // which minute stopped it and why, so the report can never imply that a
    // 60-minute soak finished when it did not.
    interrupted,
    snapshots: ordered.map((s) => ({ label: s.label, file: s.file, bytes: s.bytes, summary: s.summary })),
    comparison:
      ordered.length >= 2
        ? compareSnapshots(
            ordered[0].summary,
            ordered[ordered.length - 1].summary,
            ordered[0].label,
            ordered[ordered.length - 1].label,
          )
        : null,
    growth: {
      firstMinuteMiB: first.jsHeapUsedMiB,
      lastMinuteMiB: last.jsHeapUsedMiB,
      peakMiB: peak.jsHeapUsedMiB,
      peakMinute: peak.minute,
      deltaMiB: num(last.jsHeapUsedMiB - first.jsHeapUsedMiB),
      deltaPerMinuteMiB: num((last.jsHeapUsedMiB - first.jsHeapUsedMiB) / Math.max(1, samples.length - 1)),
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/soak.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `# JS heap after GC: first ${first.jsHeapUsedMiB} MiB -> last ${last.jsHeapUsedMiB} MiB ` +
      `(peak ${peak.jsHeapUsedMiB} MiB at minute ${peak.minute}, ${samples.length} samples); ${OUT_DIR}/soak.json`,
  );
  if (report.comparison) {
    console.log('# retained growth between the first and last snapshot:');
    for (const row of report.comparison.grewMost.slice(0, 8)) {
      console.log(`  ${row.name}: ${(row.delta / 1024).toFixed(1)} KiB (+${row.countDelta} objects)`);
    }
  }
  return report;
}

/** What grew between two snapshots, by object type+name. */
function compareSnapshots(before, after, beforeLabel, afterLabel) {
  const names = new Set([...Object.keys(before.topRetained.map((r) => r.name)), ...after.topRetained.map((r) => r.name)]);
  const rows = [];
  for (const name of names) {
    const b = before.topRetained.find((r) => r.name === name) || { bytes: 0, count: 0 };
    const a = after.topRetained.find((r) => r.name === name) || { bytes: 0, count: 0 };
    rows.push({ name, beforeBytes: b.bytes, afterBytes: a.bytes, delta: a.bytes - b.bytes, countDelta: a.count - b.count });
  }
  return {
    beforeLabel,
    afterLabel,
    nodeCountDelta: after.nodeCount - before.nodeCount,
    reachableBytesDelta: after.reachableBytes - before.reachableBytes,
    grewMost: rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 20),
    shrankMost: rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10),
  };
}

/** Analyse the samples and snapshots already on disk (after an interrupted soak). */
function summariseExistingSoak() {
  const { readFileSync, readdirSync } = require$fs;
  const samplePath = args.file || '.tools/soak/samples.jsonl';
  const samples = readFileSync(samplePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!samples.length) throw new Error(`${samplePath} has no samples`);
  const dir = samplePath.replace(/[/\\][^/\\]+$/, '');
  const snapshotFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.heapsnapshot'))
    .map((f) => `${dir}/${f}`);
  writeSoakReport({ samples, snapshots: [], browserProduct: null, snapshotFiles });
}

const mode = args._[0] || 'lcp';
if (mode === 'lcp') await lcpReport();
else if (mode === 'soak') await soakReport();
else if (mode === 'soak-summary') summariseExistingSoak();
else {
  console.error(`unknown mode '${mode}' - use 'lcp', 'soak' or 'soak-summary'`);
  process.exit(2);
}
process.exit(0);
