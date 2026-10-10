/**
 * Initial payload, measured from the import graph.
 *
 *   node tools/payload.js [--json]
 *
 * Walks `import` specifiers from the entry points a cold load actually fetches
 * (the scripts and stylesheets index.html references, the module the bootstrap
 * starts, and the worker's own imports), then gzips every file. No bundler is
 * involved - this project has no build step - so "bundle size" means exactly
 * what the browser downloads on a cold load, which is the number the brief's
 * budget talks about.
 *
 * The application module is named by src/boot-note.js rather than by a script
 * tag, because it is started after the first paint. Reading the entry point out
 * of the bootstrap keeps this measurement honest: if that line ever changes,
 * the walk follows it instead of silently measuring nothing.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const seen = new Set();
const rows = [];

function importsOf(source) {
  const specs = [];
  const re = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) specs.push(m[1]);
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(source))) specs.push(m[1]);
  return specs;
}

function walk(relative) {
  if (seen.has(relative)) return;
  seen.add(relative);
  const path = resolve(root, relative);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return; // a missing file is reported by the test suite, not here
  }
  const bytes = statSync(path).size;
  // Forward slashes: the report is read on every platform.
  rows.push({
    file: relative.replace(/\\/g, '/'),
    rawBytes: bytes,
    gzipBytes: gzipSync(source, { level: 9 }).length,
  });
  for (const spec of importsOf(source)) {
    if (!spec.startsWith('.')) continue; // no dependencies to follow
    walk(resolve(dirname(relative), spec).replace(root, '').replace(/^[/\\]/, ''));
  }
}

// Entry points: what index.html loads, plus the worker entry the sandbox spawns.
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) walk(m[1].replace(/^\.\//, ''));
for (const m of html.matchAll(/<link[^>]*href="([^"]+\.css)"/g)) walk(m[1].replace(/^\.\//, ''));
// The bootstrap starts the application module after the first paint; that path
// is the entry point payload.js would otherwise miss entirely, so the specifier
// is read out of the bootstrap rather than hard-coded here. The bootstrap names
// it as `import(new URL('app.js', here).href)` - a URL built from the script's
// own location, so a deployment under a subpath resolves correctly - which means
// the specifier is relative to src/, not to the project root.
const bootstrapPath = 'src/boot-note.js';
const bootstrap = readFileSync(resolve(root, bootstrapPath), 'utf8');
for (const m of bootstrap.matchAll(/import\(\s*new URL\(\s*'([^']+)'/g)) walk(join(dirname(bootstrapPath), m[1]));
// Kept for the <script> form the bootstrap used before the paint-entry trigger.
for (const m of bootstrap.matchAll(/script\.src\s*=\s*'([^']+)'/g)) walk(m[1].replace(/^\.\//, ''));
walk('src/runtime/worker.js');

rows.sort((a, b) => b.gzipBytes - a.gzipBytes);
const totalRaw = rows.reduce((a, r) => a + r.rawBytes, 0);
const totalGzip = rows.reduce((a, r) => a + r.gzipBytes, 0);
const js = rows.filter((r) => r.file.endsWith('.js'));
const css = rows.filter((r) => r.file.endsWith('.css'));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ files: rows, totalRaw, totalGzip, jsGzip: js.reduce((a, r) => a + r.gzipBytes, 0), cssGzip: css.reduce((a, r) => a + r.gzipBytes, 0) }, null, 2));
} else {
  console.log(`# payload from the import graph (${rows.length} files)`);
  for (const r of rows) {
    console.log(`  ${r.file.padEnd(34)} ${String((r.rawBytes / 1024).toFixed(1)).padStart(8)} KiB raw  ${String((r.gzipBytes / 1024).toFixed(1)).padStart(7)} KiB gzip`);
  }
  console.log(`\n  js ${(js.reduce((a, r) => a + r.gzipBytes, 0) / 1024).toFixed(1)} KiB gzip, css ${(css.reduce((a, r) => a + r.gzipBytes, 0) / 1024).toFixed(1)} KiB gzip`);
  console.log(`  total ${(totalGzip / 1024).toFixed(1)} KiB gzip / ${(totalRaw / 1024).toFixed(1)} KiB raw`);
}
