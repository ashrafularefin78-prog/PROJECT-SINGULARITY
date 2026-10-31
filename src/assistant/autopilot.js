/**
 * SINGU autopilot - generate, run, check, repair, run again.
 *
 * The planner already emits code that should pass, so the interesting case is
 * the code a human then edits. This module runs the M2 interpreter against the
 * program's own acceptance inputs, compares the trace with expectations that
 * were computed independently of the C, and applies a short list of repairs
 * that cannot silently change what the program means:
 *
 *   include   - declare the headers the called library functions need
 *   semicolon - a parser error that points at a missing ';' on the previous line
 *   brace     - one unmatched '{' at the end of the file
 *   declare   - a first assignment to an undeclared name inside main
 *   typo      - a call whose name is one edit away from a known function
 *
 * Anything outside that list is reported with the interpreter's own diagnosis
 * rather than papered over. The loop is synchronous: the interpreter is local
 * and bounded, and a deterministic transcript is easier to test.
 */

import { interpret } from '../runtime/interpreter.js';
import { review, diagnose } from './singu.js';

export const AUTOPILOT_VERSION = '1.0';

const LIBRARIES = [
  { header: 'stdio.h', calls: ['printf', 'puts', 'putchar', 'scanf', 'sscanf', 'sprintf', 'fgets', 'fputs', 'fprintf'] },
  { header: 'string.h', calls: ['strlen', 'strncpy', 'strcpy', 'strchr', 'strstr', 'strcmp', 'strtok', 'memcpy', 'memset', 'memmove'] },
  { header: 'ctype.h', calls: ['isalpha', 'isdigit', 'isspace', 'isupper', 'islower', 'toupper', 'tolower'] },
  { header: 'math.h', calls: ['sqrt', 'fabs', 'pow', 'floor', 'ceil', 'sin', 'cos'] },
  { header: 'stdlib.h', calls: ['malloc', 'calloc', 'realloc', 'free', 'atoi', 'atof', 'abs', 'qsort'] },
];

const TYPO_CANDIDATES = new Set([
  'printf', 'puts', 'putchar', 'scanf', 'sscanf', 'sprintf', 'fgets',
  'strlen', 'strncpy', 'strcpy', 'strchr', 'strstr', 'strcmp', 'memcpy', 'memset',
  'isalpha', 'isdigit', 'isspace', 'isupper', 'islower', 'toupper', 'tolower',
  'sqrt', 'fabs', 'pow', 'floor', 'ceil', 'malloc', 'calloc', 'realloc', 'free',
  'atoi', 'atof', 'abs',
]);

const bare = (code) => String(code)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''");

const callsNamed = (source, name) => new RegExp(`\\b${name}\\s*\\(`).test(source);

function missingIncludes(code) {
  const source = bare(code);
  const present = new Set([...source.matchAll(/#include\s*<([^>]+)>/g)].map((m) => m[1]));
  return LIBRARIES.filter((lib) => !present.has(lib.header) && lib.calls.some((name) => callsNamed(source, name)));
}

function includeRepair(code) {
  const missing = missingIncludes(code);
  if (!missing.length) return null;
  const lines = String(code).split('\n');
  let lastInclude = -1;
  lines.forEach((line, index) => {
    if (/^\s*#include\b/.test(line)) lastInclude = index;
  });
  const inserts = missing.map((lib) => `#include <${lib.header}>`);
  if (lastInclude >= 0) lines.splice(lastInclude + 1, 0, ...inserts);
  else lines.unshift(...inserts);
  return {
    rule: 'include',
    line: lastInclude + 2,
    detail: `Added ${inserts.join(', ')} for the library calls the code already makes.`,
    code: lines.join('\n'),
  };
}

function semicolonRepair(code, error) {
  if (error?.stage !== 'Parse' || !/expected ;/.test(error.message)) return null;
  const lines = String(code).split('\n');
  const index = (error.line || 0) - 1;
  const previous = index - 1;
  if (previous < 0 || index > lines.length) return null;
  const line = lines[previous];
  const trimmed = line.trimEnd();
  // Only a complete-looking statement is repaired. A dangling header, comma or
  // operator means the missing ';' is somewhere else and needs a human.
  if (!trimmed || /[;{},:]$/.test(trimmed)) return null;
  if (/^\s*(if|for|while|switch|else)\b/.test(trimmed)) return null;
  lines[previous] = trimmed + ';';
  return {
    rule: 'semicolon',
    line: previous + 1,
    detail: `Added the missing ';' at the end of line ${previous + 1}, which the parser reported at line ${error.line}.`,
    code: lines.join('\n'),
  };
}

function braceRepair(code, error) {
  if (error?.stage !== 'Parse' || !/unterminated block/.test(error.message)) return null;
  const source = bare(code);
  const open = (source.match(/\{/g) || []).length;
  const close = (source.match(/\}/g) || []).length;
  if (open !== close + 1) return null;
  return {
    rule: 'brace',
    line: String(code).split('\n').length,
    detail: 'Closed the single unmatched block brace at the end of the file.',
    code: `${String(code).replace(/\s+$/, '')}\n}\n`,
  };
}

function declarationRepair(code, error) {
  if (error?.stage !== 'Runtime') return null;
  const found = /(?:assignment to|read of) undeclared identifier '([A-Za-z_]\w*)'/.exec(error.message);
  if (!found) return null;
  const name = found[1];
  const main = /int\s+main\s*\([^)]*\)\s*\{/.exec(code);
  if (!main) return null;
  // Only main's body counts: a helper's `int n` parameter must not excuse an
  // assignment to an undeclared n in main.
  if (new RegExp(`\\b(?:int|double|char|long|unsigned|float|short)\\s+\\**\\s*${name}\\b`).test(bare(code.slice(main.index)))) return null;
  const at = main.index + main[0].length;
  const insert = `\n  int ${name} = 0;`;
  return {
    rule: 'declare',
    line: String(code).slice(0, at).split('\n').length,
    detail: `Declared int ${name} = 0 at the top of main; the first use of '${name}' came before any declaration.`,
    code: `${code.slice(0, at)}${insert}${code.slice(at)}`,
  };
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function typoRepair(code, error) {
  if (error?.stage !== 'Runtime') return null;
  const found = /call to undefined function '([^']+)'/.exec(error.message);
  if (!found) return null;
  const name = found[1];
  if (name === 'gets') return null;
  const userFunctions = [...bare(code).matchAll(/\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g)].map((m) => m[1]);
  const candidates = [...TYPO_CANDIDATES, ...userFunctions]
    .filter((candidate) => candidate !== name && editDistance(name, candidate) === 1);
  if (candidates.length !== 1) return null;
  const replacement = candidates[0];
  const fixed = String(code).replace(new RegExp(`\\b${name}\\s*\\(`, 'g'), `${replacement}(`);
  return {
    rule: 'typo',
    line: error.line || 1,
    detail: `Renamed the call '${name}' to '${replacement}'; it is one edit away and the only such candidate.`,
    code: fixed,
  };
}

function repairFor(code, staticReview, runs) {
  const error = runs.find((run) => !run.ok)?.run.error;
  const byError = error && (semicolonRepair(code, error) || braceRepair(code, error) || declarationRepair(code, error) || typoRepair(code, error));
  if (byError) return byError;
  if (staticReview.issues.length) return includeRepair(code);
  return null;
}

const linesOf = (output) => String(output || '').split('\n').map((line) => line.trimEnd());

function missingExpectation(output, expected) {
  const actual = linesOf(output);
  let from = 0;
  for (const want of expected) {
    let found = -1;
    for (let i = from; i < actual.length; i += 1) {
      if (actual[i] === want) { found = i; break; }
    }
    if (found < 0) return want;
    from = found + 1;
  }
  return null;
}

/**
 * Run one plan through the checks. `options.maxRepairs` defaults to 3; a
 * repair that cannot be justified is never attempted.
 */
export function autopilot(plan, options = {}) {
  const maxRepairs = Number.isInteger(options.maxRepairs) ? Math.max(0, options.maxRepairs) : 3;
  const execute = typeof options.execute === 'function' ? options.execute : (code, runOptions) => interpret(code, runOptions);
  const cases = plan.tests && plan.tests.length
    ? plan.tests.map((test) => ({ name: test.name, stdin: test.stdin || '', expect: test.expect || [] }))
    : [{ name: 'smoke run', stdin: '', expect: [] }];

  let code = String(plan.code || '');
  const attempts = [];
  const transcript = [];
  let output = '';
  let lastRuns = [];

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const staticReview = review(code);
    const runs = cases.map((item) => ({ ...item, run: execute(code, { stdin: item.stdin }) }));
    const checks = [];
    checks.push({
      id: 'review',
      ok: staticReview.issues.length === 0,
      detail: staticReview.issues.length
        ? `${staticReview.issues.length} blocking review issue(s): ${staticReview.issues.map((issue) => issue.text).join(' ')}`
        : 'Static review found no blocking issues.',
    });
    for (const item of runs) {
      const label = `run:${item.name}`;
      if (!item.run.ok) {
        const error = item.run.error || {};
        checks.push({
          id: label,
          ok: false,
          detail: `${error.stage || 'Runtime'} error at line ${error.line || '?'}: ${error.message || 'the program did not finish'}`,
        });
        continue;
      }
      checks.push({ id: label, ok: true, detail: `Completed in ${item.run.steps} step(s).` });
      if (item.expect.length) {
        const missing = missingExpectation(item.run.output, item.expect);
        checks.push({
          id: `expect:${item.name}`,
          ok: missing == null,
          detail: missing == null
            ? `All ${item.expect.length} expected line(s) appeared in order.`
            : `Expected line not found in order: "${missing}".`,
        });
      }
    }
    const live = runs.reduce((total, item) => total + (item.run.ok ? item.run.liveAllocs || 0 : 0), 0);
    checks.push({
      id: 'memory',
      ok: live === 0,
      detail: live === 0 ? 'No unreleased heap allocations across the runs.' : `${live} allocation(s) were never freed.`,
    });
    lastRuns = runs;
    output = runs.find((item) => item.run.ok)?.run.output || '';
    const failed = checks.filter((check) => !check.ok);
    attempts.push({ attempt: attempt + 1, checks, repairs: [] });
    transcript.push(`Attempt ${attempt + 1}: ${checks.length - failed.length}/${checks.length} checks passed.`);

    if (!failed.length) {
      transcript.push(`PASS: ${runs.length} acceptance run(s), ${runs.reduce((total, item) => total + (item.run.ok ? item.run.steps : 0), 0)} step(s), balanced heap.`);
      return {
        ok: true,
        code,
        engine: plan.engine,
        title: plan.title,
        attempts,
        checks,
        runs,
        output,
        repairLog: attempts.flatMap((entry) => entry.repairs),
        warnings: staticReview.hints,
        transcript,
      };
    }

    const repair = attempt < maxRepairs ? repairFor(code, staticReview, runs) : null;
    if (!repair) {
      const error = runs.find((item) => !item.run.ok)?.run.error;
      transcript.push(`STOP: no safe repair for "${failed[0].id}". ${failed[0].detail}`);
      if (error) for (const line of diagnose(error)) transcript.push(`  ${line.severity} line ${line.line}: ${line.text}`);
      return {
        ok: false,
        code,
        engine: plan.engine,
        title: plan.title,
        attempts,
        checks,
        runs,
        output,
        repairLog: attempts.flatMap((entry) => entry.repairs),
        warnings: staticReview.hints,
        transcript,
        error,
        diagnostics: error ? diagnose(error) : [],
        failure: failed[0],
      };
    }
    transcript.push(`Repair (${repair.rule}): ${repair.detail}`);
    attempts[attempts.length - 1].repairs.push({ rule: repair.rule, line: repair.line, detail: repair.detail });
    code = repair.code;
  }

  return {
    ok: false,
    code,
    engine: plan.engine,
    title: plan.title,
    attempts,
    checks: attempts[attempts.length - 1].checks,
    runs: lastRuns,
    output,
    repairLog: attempts.flatMap((entry) => entry.repairs),
    warnings: review(code).hints,
    transcript,
    failure: { id: 'repairs', detail: 'The repair budget was exhausted.' },
  };
}
