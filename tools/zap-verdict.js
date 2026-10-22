/**
 * Read a ZAP JSON report and decide whether it clears this project's bar.
 *
 *   node tools/zap-verdict.js report_json.json
 *   node tools/zap-verdict.js --self-test
 *
 * README and docs/SECURITY_REPORT.md already publish the bar: **0 High, 0
 * Medium, 0 Low**. Informational alerts are counted, printed and tolerated —
 * the archived baseline carries two, both properties of ZAP's own vocabulary
 * rather than findings. Anything at Low or above fails the run, so a clean
 * report cannot be claimed from a scan that found a Medium.
 *
 * This exists because `zaproxy/action-baseline` only fails a build when
 * `fail_action` is on, and that flag fails on *any* alert, informational
 * included. The workflow in .github/workflows/deployed-host-scan.yml therefore
 * records the report unconditionally and gates on this tool's exit code.
 *
 * `--self-test` runs the tool against fixtures and asserts the exit codes, so
 * the gate is exercised as a process rather than only as a function; the docs
 * gate (tools/check-docs.js) runs it, which keeps the scan verdict covered
 * without adding a Node-only file to the browser-authoritative suite.
 *
 * Exit codes:
 *   0  no alert at Low or above (informational findings are listed)
 *   1  at least one Low, Medium or High alert
 *   2  the report is missing or unreadable — a scan without a verdict is not a
 *      pass, and must not be reported as one
 */
import { existsSync, readFileSync } from 'node:fs';

const LEVELS = ['Informational', 'Low', 'Medium', 'High'];

/** The order the README and SECURITY_REPORT publish, most severe first. */
const PUBLISHED = ['High', 'Medium', 'Low', 'Informational'];

/** ZAP's report_json.json nests alerts under `site`; the summary kept in
 *  docs/reports/zap-alerts.json is a flat list. Both shapes are accepted. */
function alertsOf(report) {
  if (Array.isArray(report.site)) return report.site.flatMap((site) => site.alerts || []);
  if (Array.isArray(report.alerts)) return report.alerts;
  return [];
}

/** `riskcode` is the canonical 0-3 field; the flat summary only has a label. */
function riskOf(alert) {
  if (Number.isInteger(alert.riskcode) && LEVELS[alert.riskcode]) return LEVELS[alert.riskcode];
  const text = String(alert.riskdesc || alert.risk || '');
  return LEVELS.find((name) => text.includes(name)) || 'Unknown';
}

function label(alert) {
  const id = alert.pluginid ?? alert.id ?? '?';
  const name = alert.name || alert.alert || 'unnamed alert';
  const where = (alert.instances && alert.instances[0] && alert.instances[0].uri) || alert.url || '';
  return `${id} ${name}${where ? ` (${where})` : ''}`;
}

export function verdict(report) {
  const alerts = alertsOf(report);
  const counts = new Map(LEVELS.map((level) => [level, 0]));
  for (const alert of alerts) counts.set(riskOf(alert), (counts.get(riskOf(alert)) || 0) + 1);
  const blocking = alerts.filter((alert) => ['Low', 'Medium', 'High'].includes(riskOf(alert)));
  return { alerts, counts, blocking };
}

function render({ alerts, counts, blocking }) {
  const summary = PUBLISHED.map((level) => `${counts.get(level) || 0} ${level}`).join(', ');
  console.log(`# alerts   ${summary}`);
  if (alerts.length === 0) console.log('# the report carries no alerts at all');
  for (const alert of blocking) console.log(`  FAIL ${riskOf(alert)}: ${label(alert)}`);
  for (const alert of alerts.filter((a) => riskOf(a) === 'Informational')) {
    console.log(`  info ${label(alert)}`);
  }
  console.log(
    blocking.length === 0
      ? `  ok   no Low, Medium or High alert (${counts.get('Informational') || 0} informational)`
      : `  FAIL ${blocking.length} alert(s) at Low or above`,
  );
}

async function selfTest() {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const self = fileURLToPath(import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'zap-verdict-'));
  const fixture = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };
  const exitOf = (...args) => {
    try {
      execFileSync(process.execPath, [self, ...args], { stdio: 'ignore' });
      return 0;
    } catch (error) {
      return error.status;
    }
  };

  const checks = [];
  try {
    checks.push(
      [
        'a clean report exits 0',
        exitOf(fixture('clean.json', { site: [{ alerts: [{ riskcode: 0, name: 'Suspicious Comments' }] }] })) === 0,
      ],
      [
        'an informational-only flat report exits 0',
        exitOf(fixture('flat.json', { alerts: [{ riskdesc: 'Informational (0)', alert: 'Modern Web Application' }] })) === 0,
      ],
      [
        'a Medium exits 1',
        exitOf(fixture('medium.json', { site: [{ alerts: [{ riskcode: 2, pluginid: '10096', name: 'Timestamp Disclosure' }] }] })) === 1,
      ],
      [
        'a Low exits 1 too, because the published bar is zero',
        exitOf(fixture('low.json', { site: [{ alerts: [{ riskcode: 1, name: 'Server Leaks Version Information' }] }] })) === 1,
      ],
      ['a missing report exits 2', exitOf(join(dir, 'absent.json')) === 2],
      ['an unreadable report exits 2', exitOf(fixture('broken.json', '{ not json')) === 2],
      ['riskcode maps to the published label', riskOf({ riskcode: 3 }) === 'High'],
      ['an empty report has no alerts', alertsOf({}).length === 0],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) failed += 1;
  }
  console.log(failed === 0 ? '\nself-test ok: the verdict is not vacuous' : '\nself-test FAILED');
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  const target = process.argv[2];
  if (!target || !existsSync(target)) {
    console.error(`# no report at ${target || '(no path given)'} — nothing to prove`);
    process.exitCode = 2;
  } else {
    let report;
    try {
      // The archived report in this repo starts with a UTF-8 BOM, and a scan
      // that cannot parse its own evidence is not a verdict.
      report = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      console.error(`# ${target} is not readable JSON: ${error.message}`);
      process.exitCode = 2;
    }
    if (report) {
      console.log(`# report   ${target}`);
      const result = verdict(report);
      render(result);
      process.exitCode = result.blocking.length === 0 ? 0 : 1;
    }
  }
}
