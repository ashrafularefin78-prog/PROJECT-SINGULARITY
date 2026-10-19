/**
 * One source of truth for every published test count.
 *
 *   node tools/test-count.js --write   # run the suite, rewrite the claims
 *   node tools/test-count.js --check   # run the suite, fail on any drift
 *
 * The number comes from tests/run.js --json, never from a hand-kept constant.
 * That matters because the same total appears in the hero chip, three meta
 * descriptions, the run button, the in-app scorecard, the README badge and the
 * reports. A single edit to the suite used to leave half of them stale.
 *
 * `--check` is called by tools/check-docs.js, so CI fails when a claim and the
 * runner disagree. It does two things:
 *
 *   1. applies the same deterministic rewrite to every target and asserts the
 *      file already contains the result (catches a known-shape stale number);
 *   2. scans the test-count contexts for a number that is not one of the
 *      runner's own totals (catches a new phrasing the rewrite does not know).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const check = process.argv.includes('--check') || !write;

function runnerCounts() {
  const stdout = execFileSync(process.execPath, [join(root, 'tests/run.js'), '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  const line = stdout.trim().split(/\r?\n/).pop();
  try {
    const counts = JSON.parse(line);
    if (!Number.isInteger(counts.total) || counts.total !== counts.pass + counts.fail + counts.skip) {
      throw new Error('runner summary is internally inconsistent');
    }
    return counts;
  } catch (error) {
    throw new Error(`could not parse the runner's JSON summary (${error.message}): ${line}`);
  }
}

const counts = runnerCounts();
const { pass, fail, skip, total, suites } = counts;

const targets = {
  index: 'index.html',
  app: 'src/app.js',
  readme: 'README.md',
  changelog: 'CHANGELOG.md',
  contributing: 'CONTRIBUTING.md',
  plan: 'docs/PLAN.md',
  demo: 'docs/DEMO.md',
  load: 'docs/LOAD_CHAOS.md',
  security: 'docs/SECURITY_REPORT.md',
};

const replaceAll = (text, pattern, replacement) => text.replace(pattern, replacement);

/**
 * The deterministic rewrite. Every rule here is a *claim shape* that has
 * appeared in the repository, not a blind number replacement: `16 tests cover
 * the glTF parser` is a subset count and must not change.
 */
function transform(name, text) {
  const n = String(total);
  const s = String(suites);
  const p = String(pass);
  const k = String(skip);
  switch (name) {
    case 'index':
      return text
        .replace(/\b\d+ tests green in your browser/g, `${n} tests green in your browser`)
        .replace(/\b\d+ tests runnable in your browser/g, `${n} tests runnable in your browser`)
        .replace(/(id="hero-tests">)\d+( tests GREEN)/g, `$1${n}$2`)
        .replace(/(RUN )\d+( tests IN THIS BROWSER)/g, `$1${n}$2`);
    case 'app':
      return text
        .replace(
          /\/\/ The suite's own totals[\s\S]*?const TEST_TOTALS = \{ total: \d+, suites: \d+ \};/,
          `// The suite's own totals are generated from the runner, not maintained by\n` +
            `// hand: tools/test-count.js --write rewrites this line and every other\n` +
            `// published count from node tests/run.js --json, and tools/check-docs.js\n` +
            `// fails the build when a claim drifts from it.\n` +
            `const TEST_TOTALS = { total: ${n}, suites: ${s} };`,
        )
        .replace(
          /\{ value: '\d+', label: 'tests[\s\S]*?hint: 'run them from this page' \}/,
          `{ value: '${n}', label: 'tests - ${s} suites', hint: 'run them from this page' }`,
        )
        .replace(/\b\d+ automated tests, 41 published measurements, 0 axe violations\./g, `${n} automated tests, 41 published measurements, 0 axe violations.`);
    case 'readme':
      return text
        .replace(/tests-\d+_across_\d+_suites/g, `tests-${n}_across_${s}_suites`)
        .replace(/\*\*\d+ across \d+ suites\*\*/g, `**${n} across ${s} suites**`)
        .replace(/\*\*\d+ tests across \d+ suites\*\*/g, `**${n} tests across ${s} suites**`)
        .replace(/\b\d+ of the \d+ tests\b/g, `${p} of the ${n} tests`)
        .replace(/\b\d+ pass with \d+ browser-only skips\b/g, `${p} pass with ${k} browser-only skips`)
        .replace(/\bAll \d+ tests green\b/g, `All ${n} tests green`)
        .replace(/\(\d+ suites, \d+ tests,/g, `(${s} suites, ${n} tests,`)
        .replace(/\b\d+ tests, \d+ suites\b/g, `${n} tests, ${s} suites`);
    case 'changelog':
      return text.replace(/\b\d+ tests across \d+ suites\b/g, `${n} tests across ${s} suites`);
    case 'contributing':
      return text.replace(/\bAll \d+ tests green\b/g, `All ${n} tests green`);
    case 'plan':
      return text
        .replace(/\b\d+ automated tests across \d+ suites\b/g, `${n} automated tests across ${s} suites`)
        .replace(/\ball \d+ green\b/g, `all ${n} green`)
        .replace(/\b\d+ pass with \d+ browser-only skips\b/g, `${p} pass with ${k} browser-only skips`);
    case 'demo':
      return text
        .replace(/\b\d+ tests, \d+ suites\b/g, `${n} tests, ${s} suites`)
        .replace(/\b\d+ tests\b(?=,? all green)/g, `${n} tests`);
    case 'load':
      return text
        .replace(/\bruns \d+ of the \d+ tests\b/g, `runs ${p} of the ${n} tests`)
        .replace(/\bruns all \d+\b/g, `runs all ${n}`)
        .replace(/\b\d+ pass \+ \d+ skip\b/g, `${p} pass + ${k} skip`)
        .replace(/\b\d+ collected: \d+ pass \+ \d+ skip\b/g, `${n} collected: ${p} pass + ${k} skip`)
        .replace(/\b\d+ passed, 0 failed, 0 skipped\b/g, `${n} passed, 0 failed, 0 skipped`)
        .replace(/\b\d+ passed, 0 failed, \d+ skipped \(the \d+ need/g, `${p} passed, 0 failed, ${k} skipped (the ${k} need`)
        .replace(/# all \d+, in a real browser/g, `# all ${n}, in a real browser`);
    case 'security':
      return text
        .replace(/\b\d+ tests across \d+ suites\b/g, `${n} tests across ${s} suites`)
        .replace(/\ball \d+ green\b/g, `all ${n} green`)
        .replace(/\b\d+ pass and \d+ browser-only skips\b/g, `${p} pass and ${k} browser-only skips`)
        .replace(/\(\d+ tests, \d+ suites\)/g, `(${n} tests, ${s} suites)`);
    default:
      return text;
  }
}

const allowed = new Set([total, pass, skip, suites, 0]);
const suspicious = [
  /\b(\d+)\s+(?:automated\s+)?tests?\s+(?:across|green|runnable|of the)/gi,
  /\b(?:all|RUN)\s+(\d+)\s+tests\b/gi,
  /\btests-(\d+)_across_(\d+)_suites/gi,
  /\b(\d+)\s+passed,\s+(\d+)\s+failed/gi,
  /\b(\d+)\s+of the\s+(\d+)\s+tests\b/gi,
  /\b(\d+)\s+pass with\s+(\d+)\s+browser-only skips\b/gi,
];

let failures = 0;
const report = [];
for (const [name, rel] of Object.entries(targets)) {
  const path = join(root, rel);
  const before = readFileSync(path, 'utf8');
  const after = transform(name, before);
  if (write) {
    if (after !== before) {
      writeFileSync(path, after);
      report.push(`wrote ${rel}`);
    }
    continue;
  }
  if (after !== before) {
    failures += 1;
    report.push(`FAIL ${rel}: contains a test-count claim that does not match the runner (${total} tests, ${suites} suites)`);
  }
  for (const pattern of suspicious) {
    for (const match of before.matchAll(pattern)) {
      const numbers = match.slice(1).filter(Boolean).map(Number);
      if (numbers.some((value) => !allowed.has(value))) {
        failures += 1;
        report.push(`FAIL ${rel}: suspicious test count "${match[0]}" (runner: ${total} total, ${pass} pass, ${skip} skip, ${suites} suites)`);
      }
    }
  }
}

if (write) {
  console.log(`test counts: ${total} tests in ${suites} suites (${pass} pass, ${skip} skip in bare Node)`);
  for (const line of report) console.log(`  ${line}`);
  if (!report.length) console.log('  every published count already matches');
  process.exit(0);
}

if (failures) {
  console.error(report.join('\n'));
  console.error(`\n${failures} test-count claim(s) drifted: run node tools/test-count.js --write`);
  process.exit(1);
}
console.log(`  ok   test counts match the runner: ${total} tests, ${suites} suites, ${pass} pass, ${skip} skip`);
