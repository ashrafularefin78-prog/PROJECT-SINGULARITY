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
const relayLoad = json('docs/reports/relay-load.json');
const relayChaos = json('docs/reports/relay-chaos.json');
const relayFailover = json('docs/reports/relay-failover.json');
const nvda = json('docs/reports/nvda-session.json');

const files = {
  report: read('docs/LOAD_CHAOS.md'),
  readme: read('README.md'),
  plan: read('docs/PLAN.md'),
  demo: read('docs/DEMO.md'),
  chart: read('docs/charts/budget.svg'),
  a11y: read('docs/A11Y_VALIDATION.md'),
  nvda: read('docs/reports/nvda-session.md'),
  redteam: read('docs/reports/red-team-session.md'),
  source: read('src/app.js'),
};

const app = payload.files.find((f) => f.file === 'src/app.js');
const interp = payload.files.find((f) => f.file === 'src/runtime/interpreter.js');
const preprocess = payload.files.find((f) => f.file === 'src/runtime/preprocess.js');
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
claim('tools/payload.js --json src/runtime/interpreter.js', `(${kib(interp.gzipBytes)} KiB gzip of ${kib(interp.rawBytes)} KiB raw)`, ['report']);
claim('tools/payload.js --json src/runtime/preprocess.js', `(${kib(preprocess.gzipBytes)} KiB gzip)`, ['report']);

// The screen-reader artifact is a measured run, not prose. The step and failure
// counts must agree with the report, and the M7 score must be the one the app
// actually publishes - not the structural maximum that drifted into README 708.
const modulePoints = [...read('src/app.js').matchAll(/id: 'M(\d)'.*?points: (\d+)/g)].map((m) => Number(m[2]));
const scoreTotal = modulePoints.reduce((a, b) => a + b, 0);
claim('docs/reports/nvda-session.json summary', `${nvda.summary.steps}/${nvda.summary.steps} steps, ${nvda.summary.failed} failures`, ['a11y']);
claim('docs/reports/nvda-session.json summary', `${nvda.summary.steps}/${nvda.summary.steps} steps passed`, ['nvda']);
claim('src/app.js MODULE_STATUS points', `${scoreTotal} / 1000`, ['readme']);
claim('src/app.js MODULE_STATUS points', `Evidence-backed score: ${modulePoints[6]}/100`, ['a11y']);
claim('src/app.js MODULE_STATUS points', `score is ${modulePoints[6]}/100`, ['nvda']);
// M8's score is quoted in the red-team report too, and every scored roadmap
// entry the app draws must quote the same points the scorecard carries. M8
// once read 96 in the scorecard, the roadmap and a case study at the same
// time; parsing the entries catches the next drift even if the prose around
// them is rewritten.
claim('src/app.js MODULE_STATUS points', `does not raise M8's ${modulePoints[7]}/100`, ['redteam']);
for (const entry of read('src/app.js').matchAll(/what: 'M(\d) - [^']*?\((\d+)\/100\)'/g)) {
  const id = Number(entry[1]);
  claims.push({
    from: `src/app.js ROADMAP M${id} vs MODULE_STATUS`,
    value: entry[0].replace(/\(\d+\/100\)/, `(${modulePoints[id - 1]}/100)`),
    where: ['source'],
  });
}

// The relay artifacts. `relay-load` is a fleet-wide reconciliation of (from,
// seq) keys across four generator processes against one relay process;
// `relay-chaos` is the same accounting across a SIGKILL and a replay from the
// log; `relay-failover` kills the primary for good and re-posts its whole
// backlog to a standby node from the client outboxes. The strings below are
// the report's own sentences, so a re-run that moves a number cannot leave the
// prose behind.
claim('docs/reports/relay-load.json conditions', `${relayLoad.conditions.clients.toLocaleString('en-US')} simulated clients`, ['report', 'readme', 'plan', 'chart']);
claim('docs/reports/relay-load.json latency p95', `p95 ${relayLoad.run.latencyMs[95]} ms`, ['report', 'readme', 'chart']);
claim('docs/reports/relay-load.json run', `${relayLoad.run.acked.toLocaleString('en-US')} / ${relayLoad.run.acked.toLocaleString('en-US')} acknowledged, ${relayLoad.run.delivered.toLocaleString('en-US')} delivered in ${(relayLoad.run.durationMs / 1000).toFixed(1)} s`, ['report']);
claim('docs/reports/relay-load.json conditions', `${relayLoad.conditions.shards} generator processes`, ['report']);
claim('docs/reports/relay-chaos.json chaos', `${relayChaos.chaos.acceptedBeforeKill.toLocaleString('en-US')} accepted`, ['report']);
claim('docs/reports/relay-chaos.json chaos', `${relayChaos.chaos.recoveredFromLog.toLocaleString('en-US')} / ${relayChaos.chaos.recoveredFromLog.toLocaleString('en-US')} replayed`, ['report']);
claim('docs/reports/relay-chaos.json chaos', `kill to listening again **${relayChaos.chaos.killToReadyMs} ms**`, ['report']);
claim('docs/reports/relay-chaos.json chaos', `${relayChaos.chaos.killToReadyMs} ms outage`, ['readme', 'plan']);
claim('docs/reports/relay-failover.json failover', `${relayFailover.failover.reposted.toLocaleString('en-US')} / ${relayFailover.failover.expectedPending.toLocaleString('en-US')} re-posted from client outboxes`, ['report']);
claim('docs/reports/relay-failover.json failover', `kill to first accepted post **${relayFailover.failover.failoverMs} ms**`, ['report', 'readme', 'plan']);
claim('docs/reports/relay-failover.json failover', `kill to first delivery ${relayFailover.failover.drainResumeMs} ms`, ['report']);
claim('docs/reports/relay-failover.json run', `all ${relayFailover.run.acked.toLocaleString('en-US')} delivered, 0 lost, 0 duplicated`, ['report']);
claim('docs/reports/relay-failover.json failover', `${relayFailover.failover.postFailoverAcked.toLocaleString('en-US')} fresh envelopes accepted and delivered by the standby`, ['report']);
// The self-check count is the number of checks the harness defines, so the
// report's "10 checks" line moves with the code, not with a re-run.
const selfChecks = (read('tools/load-relay.js').match(/await check\(/g) || []).length;
claim('tools/load-relay.js await check calls', `${selfChecks} checks`, ['report']);
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

// Test counts are generated, so they are checked by the generator itself. It
// re-runs the suite, applies the same deterministic rewrite to the hero chip,
// the meta descriptions, the scorecard, the README and the reports, and fails
// on a claim shape it does not recognise. This is deliberately a separate
// process: the number must come from the runner, not from a constant here.
let testCounts = { ok: true, text: '' };
try {
  testCounts.text = execFileSync(process.execPath, [join(root, 'tools/test-count.js'), '--check'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch (error) {
  testCounts.ok = false;
  testCounts.text = `${error.stdout || ''}${error.stderr || ''}`.trim();
}

// The deployed-scan verdict is what the security workflow reads, so its own
// self-test runs here: the exit codes are the gate, and a parser that silently
// found nothing would turn every scan into a pass. It stays out of the browser
// suite on purpose - that suite is authoritative and this test spawns a process.
let zapVerdict = { ok: true, text: '' };
try {
  zapVerdict.text = execFileSync(process.execPath, [join(root, 'tools/zap-verdict.js'), '--self-test'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch (error) {
  zapVerdict.ok = false;
  zapVerdict.text = `${error.stdout || ''}${error.stderr || ''}`.trim();
}

// The soak's headline is a shape, not a number: the run must have completed and
// the last snapshot must not be bigger than the first. A checker that only
// matches strings would pass on a report that says the opposite.
const shapes = [
  {
    from: 'tools/zap-verdict.js --self-test',
    ok: zapVerdict.ok,
    why: 'the deployed-scan verdict passes its own self-test (clean, Low, Medium and missing-report exit codes)',
  },
  {
    from: 'tools/test-count.js --check',
    ok: testCounts.ok,
    why: 'every published test count matches the tests/run.js summary',
  },
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
  {
    from: 'docs/reports/relay-load.json',
    ok:
      relayLoad.run.attempted === relayLoad.run.acked &&
      relayLoad.run.delivered === relayLoad.run.acked &&
      relayLoad.run.lost === 0 &&
      relayLoad.run.duplicates === 0 &&
      relayLoad.run.unknown === 0,
    why: 'the report claims the thousand-client relay run acknowledged every envelope, lost none and duplicated none',
  },
  {
    from: 'docs/reports/relay-chaos.json',
    ok:
      relayChaos.chaos.pendingAtKill === relayChaos.chaos.expectedPending &&
      relayChaos.chaos.recoveredFromLog === relayChaos.chaos.expectedPending &&
      relayChaos.chaos.recoveredMatchesExpected === true &&
      relayChaos.chaos.lost === 0 &&
      relayChaos.chaos.duplicated === 0 &&
      relayChaos.run.delivered === relayChaos.run.acked,
    why: 'the report claims the node-kill chaos run replayed its whole backlog with zero loss',
  },
  {
    from: 'docs/reports/relay-failover.json',
    ok:
      relayFailover.failover.pendingAtKill === relayFailover.failover.expectedPending &&
      relayFailover.failover.reposted === relayFailover.failover.expectedPending &&
      relayFailover.failover.repostFailed === 0 &&
      relayFailover.failover.standbyPendingAfterRepost === relayFailover.failover.reposted &&
      relayFailover.failover.lost === 0 &&
      relayFailover.failover.duplicated === 0 &&
      relayFailover.run.delivered === relayFailover.run.acked,
    why: 'the report claims the entire backlog of the killed node was re-posted to the standby and delivered with zero loss and zero duplication',
  },
  {
    from: 'docs/reports/relay-chaos.json + docs/reports/relay-failover.json thresholds',
    ok:
      [relayChaos, relayFailover].every(
        (r) => Array.isArray(r.thresholds) && r.thresholds.length >= 3 && r.thresholds.every((t) => t.ok),
      ) && (relayLoad.thresholds == null || relayLoad.thresholds.every((t) => t.ok)),
    why: 'every relay report written under the threshold gate carries its verdicts, and all of them passed (the load artifact predates the gate)',
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
    if (from === 'tools/test-count.js --check' && testCounts.text) {
      console.log(testCounts.text.split(/\r?\n/).map((line) => `       ${line}`).join('\n'));
    }
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
