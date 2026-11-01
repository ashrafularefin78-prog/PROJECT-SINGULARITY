/**
 * The published type surface, checked against the code it describes.
 *
 *   node tools/check-types.js           # report the surface
 *   node tools/check-types.js --json     # same, as data
 *
 * `types/*.d.ts` is what `package.json` points editors at under `types`, and this
 * repo has no TypeScript: nothing compiles those declarations, so nothing could
 * notice that they had drifted. A name declared there but exported by no module is
 * worse than a missing declaration - it autocompletes, type-checks, and then throws
 * at runtime. This walks src/ for the exports that actually exist and reads types/
 * for the exports it advertises, then fails on any advertised name that is not real.
 *
 * Undeclared real exports are reported, not failed: the .d.ts set is a chosen
 * surface, not a mirror of the whole tree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = String.raw`([A-Za-z_$][\w$]*)`;

/** Everything a module hands to the outside: `export function* f`, `export { a as b }`. */
function exportedNames(text) {
  const names = new Set();
  for (const m of text.matchAll(new RegExp(`^export\\s+(?:async\\s+)?(?:abstract\\s+)?(?:default\\s+)?(?:function|class|const|let|var)\\s*\\*?\\s*${NAME}`, 'gm'))) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gms)) {
    for (const clause of m[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/);
      const name = (parts.length > 1 ? parts[1] : parts[0]).trim();
      if (name && name !== 'default') names.add(name);
    }
  }
  return names;
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const real = new Set();
for (const path of files(join(root, 'src'))) {
  if (!path.endsWith('.js')) continue;
  for (const name of exportedNames(readFileSync(path, 'utf8'))) real.add(name);
}

const declarations = [];
for (const path of files(join(root, 'types'))) {
  if (!path.endsWith('.d.ts') || path.endsWith('index.d.ts')) continue;
  const text = readFileSync(path, 'utf8');
  for (const m of text.matchAll(new RegExp(`^export declare (?:async )?(?:abstract )?(?:function|class|const|let|var)\\s*\\*?\\s*${NAME}`, 'gm'))) {
    declarations.push({ file: path.slice(root.length + 1).replace(/\\/g, '/'), name: m[1] });
  }
}

const phantom = declarations.filter((d) => !real.has(d.name));
const asJson = process.argv.includes('--json');

if (asJson) {
  console.log(JSON.stringify({ declared: declarations.length, real: real.size, phantom }, null, 2));
} else {
  for (const { file, name } of phantom) console.log(`  FAIL ${file} declares ${name}(), which no module under src/ exports`);
  console.log(
    phantom.length
      ? `\n${phantom.length} of ${declarations.length} published declarations describe an export that does not exist`
      : `ok   all ${declarations.length} declarations in types/ name a real export of the ${real.size} in src/`,
  );
}
if (phantom.length) process.exitCode = 1;
