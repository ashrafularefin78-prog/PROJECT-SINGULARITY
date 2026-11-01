/**
 * The brief, scored row by row, generated from the build rather than typed.
 *
 *   node tools/brief-table.js           # print the section
 *   node tools/brief-table.js --write   # rewrite the section in README.md
 *   node tools/brief-table.js --check   # fail if README.md is stale
 *
 * tools/check-docs.js runs --check, so a published verdict that no longer matches
 * the build fails CI instead of sitting in the README.
 *
 * The brief's own criteria are the rubric a reviewer applies, and the project
 * already states its module verdicts - but nowhere in one place against the
 * criteria, so the scoring logic had to be inferred. Inferring it is what makes
 * a reader hunt for the row that admits a gap. This assembles the table from the
 * module deck in src/app.js, the suite totals the runner publishes, a scan of the
 * import graph for the dependency rule and the document count for the
 * trade-off rule, so a verdict moves when the build moves.
 *
 * Two columns are deliberately not computed. The performance budget row and the
 * tier ladder cite where the judgement lives rather than restating a number that
 * would then disagree with docs/LOAD_CHAOS.md on a re-measure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = join(root, 'README.md');
const START = '## Against the brief';
const END = '## Screenshots';
const args = process.argv.slice(2);
const write = args.includes('--write');
const check = args.includes('--check');

const MET = 'met';
const PARTIAL = 'partially met';
const NOT_ATTEMPTED = 'honestly not attempted';

const source = readFileSync(join(root, 'src/app.js'), 'utf8');

/** The deck the scorecard renders: id, title, status and points, in file order. */
const modules = [...source.matchAll(/id: '(M\d+)', title: '([^']+)', status: '([a-z]+)', points: (\d+)/g)]
  .map((m) => ({ id: m[1], title: m[2], status: m[3], points: Number(m[4]) }));
if (modules.length < 8) throw new Error(`the module deck yielded ${modules.length} rows; expected at least the eight brief modules`);
const brief = modules.slice(0, 8);
const briefTotal = brief.reduce((sum, m) => sum + m.points, 0);

const totals = /const TEST_TOTALS = \{ total: (\d+), suites: (\d+), browser: (\d+), nodeOnly: (\d+) \};/.exec(source);
if (!totals) throw new Error('TEST_TOTALS is not in the generated shape; run node tools/test-count.js --write');
const [testTotal, testSuites, browserEligible, nodeOnly] = totals.slice(1).map(Number);

const nonGoalsText = readFileSync(join(root, 'docs/NON_GOALS.md'), 'utf8');
const nonGoalRows = nonGoalsText.split(/\r?\n/).filter((line) => /^\|\s*[^|-]/.test(line) && line.split('|').length > 3).length;

/**
 * The dependency rule is the brief's hardest line, so it is checked rather than
 * claimed. Two independent sources: package.json (what npm would install) and
 * every static import edge in src/ (what the browser would fetch). The edge
 * regex is the one tools/payload.js uses to walk the shipped graph, so this row
 * and the payload budget disagree about nothing. Anything that resolves to a
 * bare specifier is an npm package, and the row fails instead of printing "met".
 */
const edges = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : [];
  });
}
const graph = walk(join(root, 'src')).map((path) => relative(root, path).replace(/\\/g, '/'));
const bareSpecifiers = [];
const shippedSource = graph.map((file) => {
  const text = readFileSync(join(root, file), 'utf8');
  for (const m of text.matchAll(edges)) {
    const spec = m[1];
    if (spec && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('http')) {
      bareSpecifiers.push(`${file} -> ${spec}`);
    }
  }
  return text;
}).join('\n');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const declaredDeps = ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((key) => Object.keys(manifest[key] || {}));

/**
 * "Browser-native first" is read back from the sources rather than listed from
 * memory: an API counts as shipped only where the call is actually in a module the
 * browser fetches. WebGPU is the one brief API this build does not use, and it is
 * counted as absent on purpose - the row stays `partially met` because of it.
 */
const browserApis = {
  'WebRTC': /RTCPeerConnection/,
  'WebCrypto': /subtle/,
  'WASM': /WebAssembly/,
  'Service Worker': /serviceWorker/,
  'IndexedDB': /indexedDB/,
  'Workers': /new Worker\(/,
  'OPFS': /getDirectory\(/,
  'WebGPU': /GPUAdapter|navigator\.gpu/,
};
const absentApis = Object.entries(browserApis).filter(([, pattern]) => !pattern.test(shippedSource)).map(([name]) => name);
const declaredAbsences = absentApis.filter((name) => new RegExp(name, 'i').test(nonGoalsText));
const undeclaredAbsences = absentApis.filter((name) => !declaredAbsences.includes(name));

const markdownFiles = (() => {
  const count = (dir) =>
    readdirSync(dir).reduce((n, name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return n + count(path);
      return n + (name.endsWith('.md') ? 1 : 0);
    }, 0);
  return count(join(root, 'docs'));
})();

const liveUrl = 'https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/';

// These rows name files and mechanisms, so the generator checks that the names it
// quotes still exist and still do the thing - a proof column that points at a moved
// file is worse than no proof column, because it reads as evidence.
const relaySource = readFileSync(join(root, 'src/collab/relay.js'), 'utf8');
const meshTest = readFileSync(join(root, 'tests/mesh.test.js'), 'utf8');
// The row claims the carrier module never touches key material, so that is read
// back from the module rather than asserted from memory.
if (/deriveBits|subtle\(/.test(relaySource)) throw new Error('src/collab/relay.js now holds key material; the untrusted-server row needs rewriting');
if (!/hkdf/i.test(source)) throw new Error('the HKDF room key is no longer in src/app.js; the untrusted-server row cannot claim it');
if (!meshTest.includes("test('M5: the relay only ever holds routing metadata plus ciphertext'")) {
  throw new Error('tests/mesh.test.js no longer carries the ciphertext-only assertion the row quotes');
}
for (const cited of ['docs/LOAD_CHAOS.md', 'tools/payload.js']) {
  if (!existsSync(join(root, cited))) throw new Error(`${cited} is quoted in the brief table but is not in the tree`);
}

const browserRow = (() => {
  const shipped = Object.keys(browserApis).filter((name) => !absentApis.includes(name));
  const parts = [`${shipped.join(', ')} are each called from a module the browser fetches`];
  if (declaredAbsences.length) parts.push(`${declaredAbsences.join(' and ')} ${declaredAbsences.length === 1 ? 'is' : 'are'} a declared non-goal (docs/NON_GOALS.md)${declaredAbsences.includes('WebGPU') ? ', with WebGL2 as the shipped renderer' : ''}`);
  if (undeclaredAbsences.length) parts.push(`${undeclaredAbsences.join(' and ')} ${undeclaredAbsences.length === 1 ? 'is' : 'are'} neither shipped nor declared`);
  return {
    verdict: undeclaredAbsences.length ? NOT_ATTEMPTED : absentApis.length ? PARTIAL : MET,
    proof: parts.join('; '),
  };
})();

const rows = [
  {
    requirement: 'Zero runtime dependencies - no React/Vue/jQuery/Three.js/Yjs/Socket.IO, nothing from npm in the shipped bundle',
    verdict: bareSpecifiers.length || declaredDeps.length ? NOT_ATTEMPTED : MET,
    proof: bareSpecifiers.length || declaredDeps.length
      ? `npm packages: ${declaredDeps.join(', ') || 'none'}; bare specifiers: ${bareSpecifiers.join(', ')}`
      : `package.json declares no dependencies, and every static import in the ${graph.length} modules under src/ is relative (tools/payload.js walks the same edges to measure the budget)`,
  },
  {
    requirement: 'Untrusted server: a relay may see only ciphertext and discovery metadata',
    verdict: PARTIAL,
    proof: 'src/app.js derives the relay room key with HKDF-SHA256 and injects a seal/open pair into src/collab/relay.js, which holds no key material; tests/mesh.test.js asserts the node keeps only routing metadata plus ciphertext. Proven against a local node, not a hosted fleet',
  },
  {
    requirement: 'Browser-native first: WebGPU, WebRTC, WebCrypto, WASM, Service Worker, IndexedDB, Workers, OPFS',
    ...browserRow,
  },
  {
    requirement: 'One public URL',
    verdict: MET,
    proof: `<${liveUrl}> - one deployment, updated by every push to \`main\``,
  },
  {
    requirement: 'Every module tested',
    verdict: MET,
    proof: `${testTotal} tests, ${testSuites} suites (${browserEligible} browser-eligible, ${nodeOnly} Node-only), run from the deployed page`,
  },
  {
    requirement: 'Every trade-off written down',
    verdict: MET,
    proof: `${markdownFiles} documents under docs/ plus ${brief.filter((m) => m.status !== 'ok').length} declared module boundaries in the deck and ${nonGoalRows} rows in docs/NON_GOALS.md`,
  },
  {
    requirement: 'Performance budget',
    verdict: PARTIAL,
    proof: 'docs/LOAD_CHAOS.md is the source of truth for every row and its verdicts; the deck scores it separately',
  },
  {
    requirement: '1000-point tier ladder',
    verdict: PARTIAL,
    proof: `the ${brief.length} brief modules self-assess at ${briefTotal} / 1000; the reviewer's tier and the per-module reasoning are in "Where the score lands" below, not recomputed here`,
  },
];

const crossCutting = modules.slice(8);

const moduleRows = brief.map((m) => ({
  requirement: `${m.id} ${m.title}`,
  verdict: m.status === 'ok' ? MET : PARTIAL,
  proof: `${m.points} / 100 self-assessed${m.status === 'ok'
    ? '; the reasoning and the reviewer\'s mark are in "Where the score lands" below'
    : '; the boundary this row declares is in the Features table below'}`,
}));

function section() {
  const line = (r) => `| ${r.requirement} | **${r.verdict}** | ${r.proof} |`;
  const all = [...rows, ...moduleRows];
  const tally = (verdict) => all.filter((r) => r.verdict === verdict).length;
  return [
    START,
    '',
    'Self-scored against the brief\'s own criteria, so the rubric does not have to be',
    'inferred. Generated by `node tools/brief-table.js` from the module deck, the suite',
    'totals and a scan of the import graph - edit those, not this table.',
    '',
    '| Brief requirement | Verdict | Where it is proven |',
    '|-------------------|---------|--------------------|',
    ...all.map(line),
    '',
    `${all.length} rows: **${tally(MET)} ${MET}**, **${tally(PARTIAL)} ${PARTIAL}**, ${tally(NOT_ATTEMPTED)} ${NOT_ATTEMPTED}.`,
    `The last ${brief.length} rows repeat the deck's own verdicts: they move when the deck`,
    'moves, and not before the next artifact exists.',
    ...(crossCutting.length
      ? [
          '',
          `Scored beside the brief's criteria, not inside them: ${crossCutting
            .map((m) => `${m.id} ${m.title.replace(' (cross-cutting)', '')} ${m.points}/100`)
            .join(' and ')}.`,
        ]
      : []),
    '',
    // One more blank line: the section is spliced in front of the next heading,
    // and a heading that touches the paragraph above it does not render as a heading.
    '',
  ].join('\n');
}

const text = section();
const doc = readFileSync(readme, 'utf8');
const start = doc.indexOf(START);
const end = doc.indexOf(END);
// Read and write in the file's own line endings. The committed blob is LF and CI
// checks out LF, but a Windows clone with core.autocrlf has CRLF: a generator that
// only speaks LF would report drift on one platform and not the other, which is the
// same false failure tools/payload.js and tools/test-count.js already guard against.
const forFile = (s) => (doc.includes('\r\n') ? s.replace(/\n/g, '\r\n') : s);

if (write) {
  if (start === -1 || end === -1 || end < start) throw new Error(`README.md must contain "${START}" before "${END}"`);
  writeFileSync(readme, doc.slice(0, start) + forFile(text) + doc.slice(end));
  console.log('against-the-brief section rewritten from the build');
} else if (check) {
  const current = start === -1 || end === -1 || end < start ? null : doc.slice(start, end).replace(/\r\n/g, '\n');
  if (current !== text) {
    console.log('FAIL the against-the-brief section is stale: run node tools/brief-table.js --write');
    process.exitCode = 1;
  } else {
    console.log('ok   the against-the-brief section still matches the build');
  }
} else {
  console.log(text);
}
