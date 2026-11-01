/**
 * The evidence index: every artifact in docs/reports, published as data.
 *
 *   node tools/measurements.js           # write docs/reports/measurements.json
 *   node tools/measurements.js --json    # print it, write nothing
 *   node tools/measurements.js --check   # fail if the index no longer matches the directory
 *
 * tools/check-docs.js runs --check, so an artifact that is deleted, renamed or
 * edited without regenerating the index fails CI rather than quietly leaving the
 * published "N published measurements" describing a directory it no longer is.
 *
 * The project's standard is that a claim is measured or not made. The count of
 * published measurements was the one number in that standard that was typed:
 * src/app.js prints "N published measurements" and tools/test-count.js carried
 * the literal. Nothing derived it, so nothing could check it. This walks the
 * directory that holds the evidence and counts what is actually there, which
 * also makes a deleted or renamed artifact visible as a count change instead of
 * a sentence that quietly stays true.
 *
 * A measurement is a JSON artifact that parses and carries its own timestamp;
 * anything else in the directory is a record (a Markdown session write-up, a
 * header dump, an HTML scan report) and is published as one rather than
 * inflated into the measurement count. An unparseable .json is an error, not a
 * record: one archived ZAP export begins with a UTF-8 BOM, which tools/zap-verdict.js
 * strips on read and a reviewer's `JSON.parse` does not, so the BOM is reported
 * per entry rather than silently repaired.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'docs', 'reports');
const INDEX = 'measurements.json';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const check = args.includes('--check');

const TIMESTAMPS = ['measuredAt', 'generatedAt', 'fetchTime', 'date'];
const DESCRIPTIONS = ['note', 'label', 'conditions', 'title'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The first timestamp the artifact records about itself, if it records one. */
const ownTimestamp = (value) => {
  for (const key of TIMESTAMPS) if (typeof value[key] === 'string') return { key, value: value[key] };
  return null;
};

/** The first self-description the artifact carries, so `what` is quoted, not invented. */
const ownDescription = (value) => {
  for (const key of DESCRIPTIONS) {
    const text = value[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
    if (text && typeof text === 'object') return JSON.stringify(text);
  }
  if (typeof value.kind === 'string') return value.kind;
  return null;
};

function entries() {
  return readdirSync(dir)
    .filter((name) => name !== INDEX)
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(dir, name));
      const entry = {
        file: name,
        kind: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
      if (entry.kind !== 'json') return { ...entry, category: 'record' };
      const text = bytes.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) entry.utf8Bom = true;
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch {
        return { ...entry, category: 'error', why: 'not valid JSON' };
      }
      const stamp = parsed && typeof parsed === 'object' ? ownTimestamp(parsed) : null;
      const what = parsed && typeof parsed === 'object' ? ownDescription(parsed) : null;
      if (what) entry.what = what;
      if (stamp) entry.stamp = stamp;
      return { ...entry, category: stamp ? 'measurement' : 'record' };
    });
}

function index() {
  const list = entries();
  const count = (category) => list.filter((e) => e.category === category).length;
  return {
    generatedAt: new Date().toISOString(),
    directory: 'docs/reports',
    counts: {
      artifacts: list.length,
      measurements: count('measurement'),
      records: count('record'),
      errors: count('error'),
    },
    entries: list,
  };
}

const report = index();
const withoutStamp = (entry) => ({ ...entry, generatedAt: undefined });
const stable = (value) => JSON.stringify({ ...value, generatedAt: undefined, entries: value.entries.map(withoutStamp) }, null, 2);

if (check) {
  let failures = 0;
  for (const entry of report.entries) {
    if (entry.category !== 'error') continue;
    failures += 1;
    console.log(`  FAIL ${entry.file} is ${entry.why}`);
  }
  const published = stable(report);
  let archived = null;
  let current = null;
  try {
    archived = JSON.parse(readFileSync(join(dir, INDEX), 'utf8'));
    current = stable(archived);
  } catch {
    archived = null;
    current = null;
  }
  if (current !== published) {
    failures += 1;
    console.log(`  FAIL ${INDEX} does not match the directory: run node tools/measurements.js`);
    if (archived) {
      // Equal counts with an unequal index is the confusing case - a re-measured
      // artifact changes its bytes but not how many files there are. Say which.
      if (JSON.stringify(archived.counts) !== JSON.stringify(report.counts)) {
        console.log(`       published counts: ${JSON.stringify(archived.counts)}`);
        console.log(`       measured counts:  ${JSON.stringify(report.counts)}`);
      }
      const before = new Map(archived.entries.map((entry) => [entry.file, entry]));
      const after = new Map(report.entries.map((entry) => [entry.file, entry]));
      for (const file of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(file);
        const b = after.get(file);
        if (!a || !b) {
          console.log(`       ${file}: ${a ? 'in the index but not in the directory' : 'new, not published yet'}`);
          continue;
        }
        const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
        if (fields.length) console.log(`       ${file}: ${fields.join(', ')} changed since the index was written`);
      }
    }
  }
  if (failures) {
    console.log(`\n${failures} evidence-index problem(s)`);
    process.exitCode = 1;
  } else {
    console.log(
      `ok   ${report.counts.artifacts} artifacts in docs/reports: ${report.counts.measurements} measurements, ` +
        `${report.counts.records} records, all published in ${INDEX}`,
    );
  }
} else if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  writeFileSync(join(dir, INDEX), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `# ${report.counts.measurements} measurements, ${report.counts.records} records, ` +
      `${report.counts.errors} unreadable, of ${report.counts.artifacts} artifacts`,
  );
  console.log(`# written to docs/reports/${INDEX}`);
}
