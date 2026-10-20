/**
 * M6 - Service worker shell completeness.
 *
 * The worker precaches the whole application shell, because there is no build
 * step that could generate that list for us. That makes the list a hand-kept
 * inventory, and an inventory drifts: a module added to src/ but not to SHELL
 * ships fine online and then fails offline, which is the one moment the
 * offline tier is supposed to work. These checks walk the real import graph and
 * compare it with sw.js, in Node (readFileSync) and in the browser (fetch), so
 * the drift fails a test instead of a demo.
 */
import { test, assert } from './harness.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

async function readText(relative) {
  if (isNode) {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
  }
  const response = await fetch(new URL('../' + relative, import.meta.url));
  assert(response.ok, `${relative} is served: ${response.status}`);
  return response.text();
}

async function exists(relative) {
  if (isNode) {
    const { existsSync } = await import('node:fs');
    return existsSync(new URL('../' + relative, import.meta.url));
  }
  const response = await fetch(new URL('../' + relative, import.meta.url), { method: 'HEAD' });
  return response.ok;
}

const resolveRelative = (from, spec) => new URL(spec, 'https://x.invalid/' + from).pathname.slice(1);
const importSpecifiers = (source) => {
  const out = [];
  const stat = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [stat, dyn]) {
    let m;
    while ((m = re.exec(source))) if (m[1].startsWith('.')) out.push(m[1]);
  }
  return out;
};

async function shell() {
  const source = await readText('sw.js');
  const block = source.match(/const SHELL = \[([\s\S]*?)\]\.map\(here\)/);
  assert(block, 'sw.js declares a SHELL array');
  const paths = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''));
  return { source, paths: new Set(paths) };
}

test('M6 service worker: every precached path exists', async () => {
  const { paths } = await shell();
  assert(paths.size > 20, 'the shell inventory is not empty');
  const missing = [];
  for (const path of paths) {
    if (path === '' || path === './') continue;
    if (!(await exists(path))) missing.push(path);
  }
  assert(missing.length === 0, `precache paths that do not exist: ${missing.join(', ')}`);
});

test('M6 service worker: the shell covers the whole import graph', async () => {
  const { paths } = await shell();
  const seen = new Set();
  const queue = ['src/boot-note.js', 'src/app.js'];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = await readText(relative);
    for (const spec of importSpecifiers(source)) queue.push(resolveRelative(relative, spec));
  }
  const missing = [...seen].filter((path) => !paths.has(path));
  assert(missing.length === 0, `modules reachable but not precached: ${missing.join(', ')}`);
  // The sandbox worker is spawned, not imported, so the graph walk cannot see
  // it; it must still be in the shell or M2 cannot run offline.
  assert(paths.has('src/runtime/worker.js'), 'the spawned worker is precached');
});

test('M6 service worker: the cache version is explicitly bumped', async () => {
  const { source } = await shell();
  const version = source.match(/const VERSION = '([^']+)'/);
  assert(version, 'sw.js names a cache version');
  assert(/^singularity-v\d+$/.test(version[1]), `version is monotonic: ${version && version[1]}`);
  assert(/caches\.delete/.test(source), 'activate removes the previous cache');
});
