/**
 * Do the numbers in the report still match the artifacts they came from?
 *
 *   node tools/check-docs.js
 *   node tools/check-docs.js --self-test
 *
 * A written report drifts the moment the code moves: change one line of
 * `src/app.js` and every "112.9 KiB gzip" in the repository becomes a claim
 * about a build that no longer exists. Reviewers do not catch that reliably, so
 * this does it mechanically: it re-measures the payload from the import graph
 * and reads the measured JSON reports, then asserts that the exact strings the
 * documents publish are still the strings those artifacts produce.
 *
 * It deliberately checks *strings*, not prose: the sentence around a number is
 * a judgement, the number itself is a fact, and only the fact can be automated.
 *
 * `--self-test` proves the checker is not vacuous: it corrupts one expected
 * value, asserts that the check fails, and restores it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const kib = (bytes) => (bytes / 1024).toFixed(1);
const mib = (bytes) => (bytes / 1048576).toFixed(2);

const selfTest = process.argv.includes('--self-test');

// ---------------------------------------------------------------- artifacts
const payload = JSON.parse(
  execFileSync(process.execPath, [join(root, 'tools/payload.js'), '--json'], { encoding: 'utf8' }),
);
const soak = json('docs/reports/soak.json');
const mobile = json('docs/reports/lighthouse-mobile.json');
const desktop = json('docs/reports/lighthouse-desktop.json');
const a11y = json('docs/reports/a11y.json');
const durability = json('docs/reports/durability.json');

const files = {
  report: read('docs/LOAD_CHAOS.md'),
  readme: read('README.md'),
  plan: read('docs/PLAN.md'),
  demo: read('docs/DEMO.md'),
  chart: read('docs/charts/budget.svg'),
};

const app = payload.files.find((f) => f.file === 'src/app.js');
const soakFirst = soak.samples[0];
const soakLast = soak.samples[soak.samples.length - 1];
const soakPeak = soak.samples.reduce((a, s) => (s.jsHeapUsedMiB > a.jsHeapUsedMiB ? s : a));
const [snapA, snapB] = [soak.snapshots[0].summary, soak.snapshots[soak.snapshots.length - 1].summary];
const score = (report, category) => Math.round(report.categories[category].score * 100);
const marks = { mobile: [score(mobile, 'performance'), score(mobile, 'accessibility'), score(mobile, 'best-practices'), score(mobile, 'seo')], desktop: [score(desktop, 'performance'), score(desktop, 'accessibility'), score(desktop, 'best-practices'), score(desktop, 'seo')] };
const joinScores = (xs) => xs.join(' / ');

// ------------------------------------------------------------------- claims
// Each claim: the exact string that must appear, in which documents, and where
// the value came from. `from` is printed so a failure says which artifact to
// re-measure rather than just which line to edit.
const claims = [];
const claim = (from, value, where = ['report']) => claims.push({ from, value, where });

// The bare number is the one every document agrees on; the fuller phrase only
// the report uses. Both are checked, so a stale copy in any of them fails.
claim('tools/payload.js --json jsGzip', `${kib(payload.jsGzip)} KiB`, ['report', 'readme', 'demo', 'plan', 'chart']);
claim('tools/payload.js --json jsGzip', `${kib(payload.jsGzip)} KiB gzip JS`, ['report']);
claim('tools/payload.js --json totalRaw', `${kib(payload.totalRaw)} KiB raw`, ['report']);
claim('tools/payload.js --json cssGzip', `${kib(payload.cssGzip)} KiB gzip CSS`, ['report']);
claim('tools/payload.js --json src/app.js', `(${kib(app.gzipBytes)} KiB gzip of ${kib(app.rawBytes)} KiB raw)`, ['report']);
claim('docs/reports/soak.json heap series', `${soakFirst.jsHeapUsedMiB.toFixed(2)} → ${soakLast.jsHeapUsedMiB.toFixed(2)} MiB`, ['report', 'readme']);
claim('docs/reports/soak.json heap peak', `(peak ${soakPeak.jsHeapUsedMiB.toFixed(2)} MiB at minute ${soakPeak.minute})`, ['report']);
claim('docs/reports/soak.json samples', `${soak.samples.length}-sample run`, ['report']);
claim('docs/reports/soak.json snapshots', `${snapB.nodeCount.toLocaleString('en-US')} vs ${snapA.nodeCount.toLocaleString('en-US')}`, ['report']);
claim('docs/reports/soak.json snapshots', `${mib(snapB.reachableBytes)} vs ${mib(snapA.reachableBytes)} MiB`, ['report']);
claim('docs/reports/soak.json browser', soak.browser.replace('Edg/', ''), ['report']);
claim('docs/reports/lighthouse-mobile.json categories', `mobile **${joinScores(marks.mobile)}**`, ['report']);
claim('docs/reports/lighthouse-desktop.json categories', `desktop **${joinScores(marks.desktop)}**`, ['report']);
claim('docs/reports/lighthouse-mobile.json performance', `${marks.mobile[0]} of 95`, ['chart']);
claim('docs/reports/lighthouse-desktop.json categories', `${joinScores(marks.desktop)} of 95`, ['chart']);
claim('docs/reports/a11y.json axe', `0 axe-core violations, ${a11y.axe.passes} passing rule results`, ['report']);
claim('docs/reports/a11y.json browser', a11y.browser.replace('Edg/', ''), ['report']);
// One claim per row of the durability table: the delay and the verdict, both
// straight from the artifact, so a delay that starts failing cannot stay "yes"
// in the document. A delay of a second or more may be written either way (the
// table uses seconds), so both renderings are accepted - the verdict is not.
for (const row of durability.results) {
  const ms = row.reloadAfterMs;
  const labels = [
    ms === 0 ? '0 ms (immediately)' : `${ms} ms`,
    ms > 0 && ms % 1000 === 0 ? `${ms / 1000} s` : null,
  ].filter(Boolean);
  claim(
    'docs/reports/durability.json results',
    labels.map((label) => `| ${label} | ${row.survived ? 'yes' : 'no'} |`),
    ['report'],
  );
}

// The soak's headline is a shape, not a number: the run must have completed and
// the last snapshot must not be bigger than the first. A checker that only
// matches strings would pass on a report that says the opposite.
const shapes = [
  {
    from: 'docs/reports/soak.json interrupted',
    ok: soak.interrupted == null && soak.samples.length === soak.minutes,
    why: `the soak is presented as a completed ${soak.minutes}-minute run`,
  },
  {
    from: 'docs/reports/soak.json snapshots',
    ok: snapB.nodeCount < snapA.nodeCount && snapB.reachableBytes <= snapA.reachableBytes,
    why: 'the report claims the hour ended with a smaller heap than minute 10',
  },
  {
    from: 'docs/reports/durability.json',
    ok: durability.allLost === false && durability.results.every((r) => r.survived),
    why: 'the report claims every reload delay kept the edit',
  },
  {
    from: 'docs/LOAD_CHAOS.md',
    ok: !/Memory soak — no growth over the run/.test(files.report),
    why: 'section 3 still carries the placeholder heading from before the soak ran',
  },
];

if (selfTest) claims.push({ from: 'self-test', value: `${kib(payload.jsGzip + 4096)} KiB gzip JS`, where: ['report'] });

// ------------------------------------------------------------------- report
let failures = 0;
for (const { from, value, where } of claims) {
  const alternatives = Array.isArray(value) ? value : [value];
  const hit = alternatives.find((alt) => where.every((name) => files[name].includes(alt)));
  if (hit) {
    console.log(`  ok   ${hit}`);
    continue;
  }
  failures += 1;
  const missing = where.filter((name) => alternatives.every((alt) => !files[name].includes(alt)));
  console.log(`  FAIL ${alternatives.join(' or ')}`);
  console.log(`       from ${from}; missing in ${missing.join(', ')}`);
}
for (const { from, ok, why } of shapes) {
  if (ok) console.log(`  ok   ${why}`);
  else {
    failures += 1;
    console.log(`  FAIL ${why} (${from})`);
  }
}

console.log(
  failures === 0
    ? `\nall ${claims.length} published numbers still match their artifacts`
    : `\n${failures} published number(s) no longer match: re-measure, then update the document and the chart together`,
);
if (selfTest) {
  if (failures === 0) {
    console.log('self-test FAILED: a deliberately wrong number was not detected');
    process.exitCode = 1;
  } else {
    console.log('self-test ok: the injected wrong number was caught');
  }
} else if (failures) {
  process.exitCode = 1;
}
