// The Node runner discovers `tests/*.test.js`; the browser runner keeps an
// explicit list because a static page cannot read the directory. The two
// drifted once - skin.test.js existed and passed in Node while the
// authoritative browser run never loaded it - so the lists are compared here.
import { test, assert } from './harness.js';

test('browser runner registers every suite the Node runner discovers', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const discovered = readdirSync(here)
    .filter((file) => file.endsWith('.test.js'))
    .sort();
  const source = readFileSync(join(here, 'browser-runner.js'), 'utf8');
  const listed = [...source.matchAll(/'\.\/([^']+\.test\.js)'/g)].map((m) => m[1]);
  const unique = [...new Set(listed)].sort();
  assert(
    JSON.stringify(unique) === JSON.stringify(discovered),
    `browser-runner.js and tests/ disagree: listed [${unique.join(', ')}], discovered [${discovered.join(', ')}]`,
  );
}, { needs: 'node' });
