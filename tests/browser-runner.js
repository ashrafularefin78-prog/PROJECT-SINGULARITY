// Browser test runner. Loads every suite, runs it, and exposes results on
// window.__RESULTS__ so both humans and automated checks can read them.
import { capabilities, collect, unmetNeeds } from './harness.js';

const SUITES = [
  './rga.test.js',
  './history.test.js',
  './crypto.test.js',
  './compiler.test.js',
  './lang.test.js',
  './stdlib.test.js',
  './storage.test.js',
  './opfs.test.js',
  './mesh.test.js',
  './topology.test.js',
  './webrtc.test.js',
  './renderer.test.js',
  './gltf.test.js',
  './hdr.test.js',
  './env.test.js',
  './fuzz.test.js',
  './motion.test.js',
  './substrate.test.js',
  './hud.test.js',
  './a11y.test.js',
  './sw.test.js',
];

async function main() {
  const results = { pass: 0, fail: 0, skip: 0, suites: [], startedAt: Date.now(), caps: capabilities() };
  const root = document.getElementById('out');

  for (const file of SUITES) {
    const suite = { file, tests: [] };
    let tests = [];
    try {
      await import(file);
      tests = collect();
    } catch (err) {
      suite.loadError = err && err.stack ? err.stack : String(err);
      results.fail += 1;
      root.appendChild(renderSuite(suite));
      results.suites.push(suite);
      continue;
    }
    for (const t of tests) {
      const entry = { name: t.name };
      const why = unmetNeeds(t, results.caps);
      if (why) {
        entry.ok = false;
        entry.skip = why;
        results.skip += 1;
        suite.tests.push(entry);
        continue;
      }
      const t0 = performance.now();
      try {
        await t.fn();
        entry.ok = true;
        results.pass += 1;
      } catch (err) {
        entry.ok = false;
        entry.error = err && err.message ? err.message : String(err);
        results.fail += 1;
      }
      entry.ms = Math.round((performance.now() - t0) * 100) / 100;
      suite.tests.push(entry);
    }
    results.suites.push(suite);
    root.appendChild(renderSuite(suite));
  }

  results.ms = Date.now() - results.startedAt;
  const summary = document.createElement('p');
  summary.className = 'summary ' + (results.fail ? 'bad' : 'good');
  summary.textContent = `${results.pass} passed, ${results.fail} failed, ${results.skip} skipped in ${results.ms} ms`;
  root.prepend(summary);
  document.title = `${results.fail ? 'FAIL' : 'PASS'} - ${results.pass}/${results.pass + results.fail}`;
  window.__RESULTS__ = results;
  window.__DONE__ = true;
}

function renderSuite(suite) {
  const box = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = suite.file;
  box.appendChild(h);
  if (suite.loadError) {
    const p = document.createElement('pre');
    p.className = 'load-error';
    p.textContent = suite.loadError;
    box.appendChild(p);
    return box;
  }
  const ul = document.createElement('ul');
  for (const t of suite.tests) {
    const li = document.createElement('li');
    li.className = t.skip ? 'skip' : t.ok ? 'ok' : 'fail';
    li.textContent = (t.skip ? 'skip ' : t.ok ? 'ok   ' : 'FAIL ') + t.name + (t.skip ? ' (' + t.skip + ')' : ' (' + t.ms + 'ms)');
    if (!t.ok && !t.skip) {
      const pre = document.createElement('pre');
      pre.textContent = t.error;
      li.appendChild(pre);
    }
    ul.appendChild(li);
  }
  box.appendChild(ul);
  return box;
}

main().catch((err) => {
  window.__DONE__ = true;
  window.__RESULTS__ = { pass: 0, fail: 1, fatal: err && err.stack ? err.stack : String(err) };
  const pre = document.createElement('pre');
  pre.textContent = window.__RESULTS__.fatal;
  document.body.appendChild(pre);
});
