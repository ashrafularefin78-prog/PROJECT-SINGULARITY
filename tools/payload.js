/**
 * Initial payload, measured from the import graph.
 *
 *   node tools/payload.js [--json]
 *
 * Walks `import` specifiers from the entry points a cold load actually fetches
 * (the scripts and stylesheets index.html references, and the application
 * module the bootstrap starts), then gzips every file. No bundler is involved -
 * this project has no build step - so "bundle size" means exactly what the
 * browser downloads on a cold load, which is the number the brief's budget
 * talks about.
 *
 * Static `import ... from` edges are followed as part of the cold load.
 * Dynamic `import('...')` edges are *not*: those modules are fetched the first
 * time a panel needs them (the compiler in its worker, the WebGL2 engine, the
 * crypto stack and the WebRTC/relay carriers), so charging them to the cold
 * load would measure a page nobody loads. They are still walked and reported,
 * in the `deferred` block, so the whole shipped graph stays visible and a
 * module cannot hide by being imported late. The worker entry
 * (src/runtime/worker.js) is a deferred root for the same reason: the sandbox
 * spawns it when the M2 panel starts, not before.
 *
 * The application module is named by src/boot-note.js rather than by a script
 * tag, because it is started after the first paint. Reading the entry point out
 * of the bootstrap keeps this measurement honest: if that line ever changes,
 * the walk follows it instead of silently measuring nothing. It counts as
 * initial even though the bootstrap uses `import()` - it is the page's own
 * application, not an optional panel.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** Cached file facts: source text, raw size and gzip size. */
const info = new Map();
function load(relative) {
  if (info.has(relative)) return info.get(relative);
  const path = resolve(root, relative);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    info.set(relative, null); // a missing file is reported by the test suite
    return null;
  }
  // Measured on the line endings git actually stores, not on whatever this
  // checkout happens to have. `statSync().size` counts CRLF on a Windows
  // working tree and LF on the Linux runner, so the same commit published two
  // different budgets and `tools/check-docs.js` reported drift that only
  // existed on one platform. The blobs - and what a host like GitHub Pages
  // serves - are LF, so LF is both the deterministic number and the true one.
  const shipped = source.replace(/\r\n/g, '\n');
  const entry = {
    file: relative.replace(/\\/g, '/'),
    rawBytes: Buffer.byteLength(shipped, 'utf8'),
    gzipBytes: gzipSync(Buffer.from(shipped, 'utf8'), { level: 9 }).length,
  };
  info.set(relative, { source, entry });
  return info.get(relative);
}

function edgesOf(source) {
  const staticSpecs = [];
  const dynamicSpecs = [];
  // Static imports/exports: `import x from '...'`, `export { x } from '...'`.
  const stat = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = stat.exec(source))) staticSpecs.push(m[1]);
  // Dynamic imports are deferred: collected separately, never counted as cold.
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(source))) dynamicSpecs.push(m[1]);
  return { staticSpecs, dynamicSpecs };
}

const relPath = (fromFile, spec) =>
  resolve(dirname(fromFile), spec).replace(root, '').replace(/^[/\\]/, '').replace(/\\/g, '/');

function closure(roots, skip = new Set()) {
  const seen = new Set();
  const queue = roots.map((rel) => rel.replace(/\\/g, '/'));
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || skip.has(rel)) continue;
    const loaded = load(rel);
    if (!loaded) continue;
    seen.add(rel);
    for (const spec of edgesOf(loaded.source).staticSpecs) {
      if (spec.startsWith('.')) queue.push(relPath(rel, spec));
    }
  }
  return seen;
}

// ---------------------------------------------------------------- entry points
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const initialRoots = [];
for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) initialRoots.push(m[1].replace(/^\.\//, ''));
for (const m of html.matchAll(/<link[^>]*href="([^"]+\.css)"/g)) initialRoots.push(m[1].replace(/^\.\//, ''));

// The bootstrap starts the application module after the first paint; that path
// is the entry point payload.js would otherwise miss entirely, so the specifier
// is read out of the bootstrap rather than hard-coded here. The bootstrap names
// it as `import(new URL('app.js', here).href)` - a URL built from the script's
// own location, so a deployment under a subpath resolves correctly - which means
// the specifier is relative to src/, not to the project root.
const bootstrapPath = 'src/boot-note.js';
const bootstrap = readFileSync(resolve(root, bootstrapPath), 'utf8');
for (const m of bootstrap.matchAll(/import\(\s*new URL\(\s*'([^']+)'/g)) initialRoots.push(join(dirname(bootstrapPath), m[1]));
// Kept for the <script> form the bootstrap used before the paint-entry trigger.
for (const m of bootstrap.matchAll(/script\.src\s*=\s*'([^']+)'/g)) initialRoots.push(m[1].replace(/^\.\//, ''));

// ---------------------------------------------------------------- walk
const initial = closure(initialRoots);

// Deferred roots: every dynamic edge out of the initial set, plus the worker the
// sandbox spawns on demand. Everything reachable from those is deferred too.
const deferredRoots = ['src/runtime/worker.js', 'src/runtime/clang-worker.js'];
for (const rel of initial) {
  const loaded = load(rel);
  if (!loaded) continue;
  for (const spec of edgesOf(loaded.source).dynamicSpecs) {
    if (spec.startsWith('.')) deferredRoots.push(relPath(rel, spec));
  }
}
const deferred = closure(deferredRoots, initial);

const rows = [];
for (const rel of initial) rows.push({ ...load(rel).entry, deferred: false });
for (const rel of deferred) rows.push({ ...load(rel).entry, deferred: true });
rows.sort((a, b) => b.gzipBytes - a.gzipBytes);

const sum = (pred) => rows.filter(pred).reduce((a, r) => a + r.gzipBytes, 0);
const raw = (pred) => rows.filter(pred).reduce((a, r) => a + r.rawBytes, 0);
const isJs = (r) => r.file.endsWith('.js');
const isCss = (r) => r.file.endsWith('.css');

const initialRows = rows.filter((r) => !r.deferred);
const result = {
  files: rows,
  // Cold load: what a first visit downloads before a panel is opened.
  totalRaw: raw((r) => !r.deferred),
  totalGzip: sum((r) => !r.deferred),
  jsGzip: sum((r) => !r.deferred && isJs(r)),
  cssGzip: sum((r) => !r.deferred && isCss(r)),
  // Deferred graph: fetched when a panel that needs it is opened.
  deferredJsGzip: sum((r) => r.deferred && isJs(r)),
  deferredRaw: raw((r) => r.deferred),
  deferredFiles: deferred.size,
  initialFiles: initial.size,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`# initial payload from the import graph (${initialRows.length} files)`);
  for (const r of initialRows) {
    console.log(`  ${r.file.padEnd(34)} ${String((r.rawBytes / 1024).toFixed(1)).padStart(8)} KiB raw  ${String((r.gzipBytes / 1024).toFixed(1)).padStart(7)} KiB gzip`);
  }
  console.log(`\n  js ${(result.jsGzip / 1024).toFixed(1)} KiB gzip, css ${(result.cssGzip / 1024).toFixed(1)} KiB gzip`);
  console.log(`  total ${(result.totalGzip / 1024).toFixed(1)} KiB gzip / ${(result.totalRaw / 1024).toFixed(1)} KiB raw`);
  console.log(`\n# deferred: fetched on demand (${deferred.size} files, ${(result.deferredJsGzip / 1024).toFixed(1)} KiB gzip JS)`);
  for (const r of rows.filter((r) => r.deferred)) {
    console.log(`  ${r.file.padEnd(34)} ${String((r.rawBytes / 1024).toFixed(1)).padStart(8)} KiB raw  ${String((r.gzipBytes / 1024).toFixed(1)).padStart(7)} KiB gzip`);
  }
}
