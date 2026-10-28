// A visible throwaway browser avoids off-screen rAF stalls without touching user profiles.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, parseArgs, serveProject, startProjectServer } from './cdp.js';

const args = parseArgs();
const TIMEOUT = Number(args['timeout-ms'] || 180000);
// Identified in src/app.js; never infer a passing result from app source text.
const DOC_ID = 'singularity-demo';
const SOURCE = '[aria-label="C or C++ source code"]';
const GENERATED = '[aria-label="Generated C source"]';
const PROMPT = '[aria-label="What should SINGU AI build?"]';
const EDITOR = 'textarea[aria-label^="Collaborative"]';
const OUTPUT = '[aria-label="Program output"]';
const SINGU_OUTPUT = '[aria-label="SINGU sandbox output"]';
const DIAL = '[role="dialog"][aria-label="Module dial"]';
const q = JSON.stringify;
const button = (label) => `[...document.querySelectorAll('#main button')].find(b => b.textContent.trim() === ${q(label)})`;
const get = (selector) => `document.querySelector(${q(selector)})`;
// Clang forwards every nonempty write promptly (1 MiB / 4096-write caps).
// Explicitly flush a small marker before looping; no batching threshold needed.
const loop = (marker) => `#include <stdio.h>\nint main(void) { printf("${marker}\\n"); fflush(stdout); volatile unsigned n = 0; while (1) { n = n + 1; } return 0; }\n`;
const interpreterLoop = (marker) => `#include <stdio.h>\nint main(void) { printf("${marker}\\n"); int n = 0; while (1) { n = n + 1; } return 0; }\n`;

// Observers preserve browser behavior: no fake worker results, shortened timers
// or substituted compiler. The pending-write test separately gates real OPFS
// writes, forwards them unchanged, and restores its hooks in finally.
// All hooks are inside the throwaway tab.
function browserObservers() {
  const probe = window.__uiRegression = {
    intervals: new Map(), rafs: new Set(), keys: [], runs: [], renderers: [], gpu: new Map(),
  };
  const interval = window.setInterval;
  const clear = window.clearInterval;
  window.setInterval = function (fn, ms, ...rest) {
    const id = interval.call(this, fn, ms, ...rest);
    probe.intervals.set(id, ms);
    return id;
  };
  window.clearInterval = function (id) {
    probe.intervals.delete(id);
    return clear.call(this, id);
  };
  const raf = window.requestAnimationFrame;
  const cancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (fn) {
    const id = raf.call(this, now => { probe.rafs.delete(id); fn(now); });
    probe.rafs.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    probe.rafs.delete(id);
    return cancel.call(this, id);
  };
  window.addEventListener('keydown', event => {
    if (event.code === 'Backslash') {
      // Browser microtasks can run between capture and bubble listeners. Read
      // the original event after dispatch instead of capturing a premature flag.
      probe.keys.push({ trusted: event.isTrusted, composing: event.isComposing,
        get prevented() { return event.defaultPrevented; } });
    }
  }, true);
  if (window.WebGL2RenderingContext) {
    const proto = WebGL2RenderingContext.prototype;
    for (const type of ['Buffer', 'Texture', 'Framebuffer', 'VertexArray', 'Program', 'Shader', 'Renderbuffer']) {
      for (const verb of ['create', 'delete']) {
        const method = verb + type;
        const original = proto[method];
        if (!original) continue;
        proto[method] = function (...values) {
          const result = original.apply(this, values);
          if (this.canvas?.id === 'scene') {
            if (!probe.gpu.has(this)) probe.gpu.set(this, new Set());
            const owned = probe.gpu.get(this);
            if (verb === 'create' && result) owned.add(result);
            if (verb === 'delete') owned.delete(values[0]);
          }
          return result;
        };
      }
    }
  }
}

async function hooks(s) {
  await s.evaluate(`(async () => {
    const probe = window.__uiRegression;
    const { Sandbox } = await import(new URL('src/runtime/sandbox.js', document.baseURI).href);
    const owners = new WeakMap(); let nextOwner = 0;
    const original = Sandbox.prototype.start;
    Sandbox.prototype.start = function (source, options = {}) {
      if (!owners.has(this)) owners.set(this, ++nextOwner);
      const record = { owner: owners.get(this), source, phases: [], output: '', kills: 0, result: null };
      probe.runs.push(record);
      const handle = original.call(this, source, { ...options,
        onStatus: status => { record.phases.push(status.phase); options.onStatus?.(status); },
        onOutput: text => { record.output += text; options.onOutput?.(text); }
      });
      handle.promise.then(result => { record.result = result; });
      return { promise: handle.promise, kill: () => { record.kills++; return handle.kill(); } };
    };
    const { Renderer } = await import(new URL('src/graphics/renderer.js', document.baseURI).href);
    const init = Renderer.prototype.init, dispose = Renderer.prototype.dispose, frame = Renderer.prototype.frame;
    Renderer.prototype.init = function (...values) {
      if (!probe.renderers.some(r => r.instance === this)) probe.renderers.push({ instance: this, frames: 0, disposals: 0, gl: null });
      const record = probe.renderers.find(r => r.instance === this);
      const result = init.apply(this, values); record.gl = this.gl; return result;
    };
    Renderer.prototype.frame = function (...values) {
      const record = probe.renderers.find(r => r.instance === this);
      if (record) record.frames++;
      return frame.apply(this, values);
    };
    Renderer.prototype.dispose = function (...values) {
      const record = probe.renderers.find(r => r.instance === this);
      if (record) record.disposals++;
      return dispose.apply(this, values);
    };
    return true;
  })()`);
}

async function monitor(s) {
  s.networkFailures = [];
  s.childSessions = new Set();
  const requests = new Map();
  const observe = (method, params) => {
    if (method === 'Network.requestWillBeSent') requests.set(params.requestId, params.request.url);
    if (method === 'Network.loadingFailed') s.networkFailures.push({ url: requests.get(params.requestId), error: params.errorText, blocked: params.blockedReason });
  };
  for (const method of ['Network.requestWillBeSent', 'Network.loadingFailed']) s.on(method, params => observe(method, params));
  s.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    s.childSessions.add(sessionId);
    s.browser.sessions.set(sessionId, { listener: message => {
      observe(message.method, message.params);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') s.consoleErrors.push(`${targetInfo.type}: ` + message.params.args.map(a => a.value ?? a.description).join(' '));
      if (message.method === 'Runtime.exceptionThrown') s.pageErrors.push(`${targetInfo.type}: ` + (message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text));
    } });
    Promise.all(['Runtime.enable', 'Network.enable'].map(method => s.browser.request(method, {}, sessionId)))
      .then(() => s.browser.request('Runtime.runIfWaitingForDebugger', {}, sessionId))
      .catch(err => {
        // A deliberately killed worker may disappear before enable answers.
        if (!/closed|not found|No session|Session with given id/i.test(err.message)) s.pageErrors.push('Worker monitor: ' + err.message);
      });
  });
  await s.send('Network.enable');
  // Pausing service-worker startup would change the storage/cache lifecycle under test.
  await s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'worker', exclude: false }, { exclude: true }] });
}
async function foreground(s) {
  const { windowId } = await s.browser.send('Browser.getWindowForTarget', { targetId: s.targetId });
  await s.browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await s.send('Page.bringToFront');
}
async function settle(s, ms = 250) {
  // A bounded observation window, not a blind boot/compilation sleep.
  await s.evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
}
async function clickExpr(s, expr) {
  await s.waitFor(`!!(${expr}) && !(${expr}).disabled`, { timeoutMs: 30000 });
  const rect = await s.evaluate(`(() => { const e = (${expr}); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect });
}
const click = (s, label) => clickExpr(s, button(label));
async function key(s, name, code, vk, text, modifiers = 0) {
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
async function fill(s, selector, value) {
  await s.waitFor(`!!${get(selector)}`);
  await s.evaluate(`${get(selector)}.focus(); ${get(selector)}.select()`);
  if (value) await s.send('Input.insertText', { text: value });
  else await key(s, 'Backspace', 'Backspace', 8);
}
async function select(s, label, value) {
  const selector = `select[aria-label="${label}"]`;
  await s.evaluate(`(() => { const e=${get(selector)}; if (!e || e.disabled || ![...e.options].some(o=>o.value===${q(value)})) throw new Error('Unavailable select: ${label}=${value}'); e.value=${q(value)}; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  assert.equal(await s.evaluate(`${get(selector)}.value`), value);
}
async function panel(s, id) {
  await clickExpr(s, get(`#tab-${id}`));
  await s.waitFor(`!!${get(`#panel-${id} h1`)} && ${get(`#tab-${id}`)}?.getAttribute('aria-selected') === 'true'`);
  assert.equal(await s.evaluate('location.hash'), '#' + id);
}
async function lastRun(s) {
  return s.evaluate('window.__uiRegression.runs.at(-1)');
}
async function start(s, label, marker) {
  const count = await s.evaluate('window.__uiRegression.runs.length');
  await click(s, label);
  await s.waitFor(`window.__uiRegression.runs.length === ${count + 1}`);
  if (marker) {
    const ready = await s.waitFor(`(() => { const r=window.__uiRegression.runs.at(-1); return r.result ? {premature:r.result} : r.output.includes(${q(marker)}) ? {running:true} : false; })()`, { timeoutMs: TIMEOUT, intervalMs: 30 });
    assert.equal(ready.running, true, 'Run ended before its live-output checkpoint: ' + JSON.stringify(ready));
  }
  return count;
}
async function finished(s, label) {
  await s.waitFor(`window.__uiRegression.runs.at(-1)?.result && !(${button(label)})?.disabled && (${button('Kill')})?.disabled`, { timeoutMs: TIMEOUT });
  return lastRun(s);
}
async function run(s, label = 'Compile & run') {
  await start(s, label);
  return finished(s, label);
}
async function output(s, selector = OUTPUT) {
  return s.evaluate(`${get(selector)}.textContent`);
}
async function durable(s) {
  return s.evaluate(`(async () => {
    const { openLocalStore } = await import(new URL('src/storage/db.js', document.baseURI).href);
    const { RGA } = await import(new URL('src/crdt/rga.js', document.baseURI).href);
    const store = await openLocalStore();
    try {
      if (!store.persistent || !store.db) throw new Error('Actual IndexedDB required; memory fallback is not a pass');
      const ops = await store.loadOps(${q(DOC_ID)}), snapshot = await store.loadDoc(${q(DOC_ID)});
      const rga = new RGA('ui-regression-reader'); rga.merge(ops);
      return { text: rga.text(), buffered: rga.stats().buffered, count: ops.length, snapshot,
        ghostOps: ops.filter(op => op.id?.[1]?.startsWith('ghost-')).length };
    } finally { store.close(); }
  })()`);
}
async function waitDurable(s, expected) {
  const deadline = Date.now() + 15000;
  let value;
  do {
    value = await durable(s);
    if (value.text === expected && value.buffered === 0) return value;
    await settle(s, 80);
  } while (Date.now() < deadline);
  assert.equal(value.text, expected, 'IndexedDB RGA did not converge to the visible edit');
  assert.equal(value.buffered, 0, 'Durable operations have unresolved origins');
}
async function storage(s, body) {
  return s.evaluate(`(async () => { const {openLocalStore} = await import(new URL('src/storage/db.js', document.baseURI).href); const store=await openLocalStore(); try { if (!store.persistent) throw new Error('IndexedDB fallback'); ${body} } finally {store.close();} })()`);
}
async function reloadEditor(s) {
  // Page.reload can answer while the OLD editor is still mounted. Await the
  // new top-frame commit before polling DOM, or a stale textarea can fake a
  // recovery pass (and disappear immediately after waitFor returns).
  let timer;
  let committed;
  const navigation = new Promise((resolve, reject) => {
    committed = ({ frame }) => { if (!frame.parentId) resolve(); };
    timer = setTimeout(() => reject(new Error('Reload did not commit a new top-level document')), 60000);
    s.on('Page.frameNavigated', committed);
  });
  try {
    await s.send('Page.reload', { ignoreCache: true });
    await navigation;
    await foreground(s);
    await s.waitFor(`document.readyState === 'complete' && !!${get(EDITOR)} && ${get('#tab-editor')}?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 60000 });
  } finally {
    clearTimeout(timer);
    s.listeners.set('Page.frameNavigated', (s.listeners.get('Page.frameNavigated') || []).filter(handler => handler !== committed));
  }
}

const tests = [];
const test = (name, initial, fn) => tests.push({ name, initial, fn });

test('C stdio, stdin and C11 standard', 'compiler', async s => {
  await select(s, 'Compiler mode', 'c');
  await select(s, 'Language standard', 'c11');
  await fill(s, SOURCE, '#include <stdio.h>\nint main(void) { int a=0,b=0; scanf("%d %d", &a, &b); printf("UI_C_SUM=%d\\n",a+b); int c; while((c=getchar())!=EOF) putchar(c); return 0; }\n');
  await fill(s, '[aria-label="Standard input"]', '19 23\nUI_C_ECHO\n');
  const record = await run(s);
  assert.equal(record.result.ok, true, JSON.stringify(record.result));
  assert.equal(record.result.exitCode, 0);
  assert.equal(await output(s), 'UI_C_SUM=42\n\nUI_C_ECHO\n');
  assert.match(await s.evaluate("document.querySelector('#main').textContent"), /exit 0/);
});

test('C++ STL language sample with stdin', 'compiler', async s => {
  await select(s, 'Compiler mode', 'cpp');
  assert.equal(await s.evaluate(`${get('[aria-label="Language standard"]')}.value`), 'c++17');
  await click(s, 'Load language sample');
  await fill(s, '[aria-label="Standard input"]', '20 22\n');
  const record = await run(s);
  assert.equal(record.result.ok, true, JSON.stringify(record.result));
  assert.equal(await output(s), 'squares sum = 55\n1 2 5 8 \ninput sum = 42\n');
});

test('real local helper.c/helper.h upload and clear', 'compiler', async (s, files) => {
  await select(s, 'Compiler mode', 'c');
  await fill(s, SOURCE, '#include <stdio.h>\n#include "helper.h"\nint main(void) { printf("UI_HELPER=%d\\n", helper(21)); return 0; }\n');
  const { root } = await s.send('DOM.getDocument');
  const { nodeId } = await s.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[aria-label="Additional source and header files"]' });
  assert.ok(nodeId, 'Missing real upload input');
  await s.send('DOM.setFileInputFiles', { nodeId, files: [join(files, 'helper.c'), join(files, 'helper.h')] });
  await s.waitFor(`document.querySelector('#main').textContent.includes('helper.c, helper.h')`);
  const record = await run(s);
  assert.equal(record.result.ok, true, JSON.stringify(record.result));
  assert.equal(await output(s), 'UI_HELPER=42\n');
  await click(s, 'Clear extra files');
  assert.equal(await s.evaluate(`${get('[aria-label="Additional source and header files"]')}.files.length`), 0);
  const cleared = await run(s);
  assert.equal(cleared.result.ok, false, 'Clear must actually remove uploaded headers, not just their label');
  assert.match(await s.evaluate("document.querySelector('#main').textContent"), /helper\.h.*(?:not found|No such file)/i);
});

test('syntax diagnostics identify main.c line and caret', 'compiler', async s => {
  await select(s, 'Compiler mode', 'c');
  await fill(s, SOURCE, 'int main(void) {\n  int value = ;\n  return 0;\n}\n');
  const record = await run(s);
  assert.equal(record.result.ok, false);
  const text = await s.evaluate("document.querySelector('#main').textContent");
  assert.match(text, /main\.c(?::2:|.*line 2)/);
  assert.match(text, /error/i);
  assert.match(text, /\^/);
  assert.equal(await output(s), '', 'Syntax errors must not run a program');
});

test('nonzero native exit is preserved', 'compiler', async s => {
  await select(s, 'Compiler mode', 'c');
  await fill(s, SOURCE, '#include <stdio.h>\nint main(void) { printf("UI_EXIT_7\\n"); return 7; }\n');
  const record = await run(s);
  assert.equal(record.result.exitCode, 7);
  assert.equal(await output(s), 'UI_EXIT_7\n');
  assert.match(await s.evaluate("document.querySelector('#main').textContent"), /exit 7/);
});

test('Load infinite loop runs WebAssembly and Kill terminates it', 'compiler', async s => {
  await select(s, 'Compiler mode', 'c');
  await click(s, 'Load infinite loop');
  await start(s, 'Compile & run');
  await s.waitFor("window.__uiRegression.runs.at(-1).phases.includes('running') && !window.__uiRegression.runs.at(-1).result", { timeoutMs: TIMEOUT, intervalMs: 30 });
  assert.equal(await s.evaluate(`(${button('Compile & run')}).disabled`), true);
  assert.equal(await s.evaluate(`${get('[aria-label="Compiler mode"]')}.disabled`), true);
  await click(s, 'Kill');
  const record = await finished(s, 'Compile & run');
  assert.equal(record.kills, 1);
  assert.equal(record.result.killed, true);
  assert.match(await s.evaluate("document.querySelector('#main').textContent"), /terminated by the user/);
});

test('source edit cancels a live native run; new result owns terminal', 'compiler', async s => {
  await select(s, 'Compiler mode', 'c');
  await fill(s, SOURCE, loop('UI_OLD_C'));
  const index = await start(s, 'Compile & run', 'UI_OLD_C');
  await fill(s, SOURCE, '#include <stdio.h>\nint main(void) { printf("UI_NEW_C\\n"); return 0; }\n');
  await s.waitFor(`window.__uiRegression.runs[${index}].result?.killed === true`);
  const before = await s.evaluate(`({out:${get(OUTPUT)}.textContent, text:document.querySelector('#main').textContent})`);
  await settle(s);
  assert.deepEqual(await s.evaluate(`({out:${get(OUTPUT)}.textContent, text:document.querySelector('#main').textContent})`), before, 'Cancelled completion must not append diagnostics or update metadata');
  assert.equal(await s.evaluate(`(${button('Kill')}).disabled`), true);
  const record = await run(s);
  assert.equal(record.result.ok, true);
  assert.equal(await output(s), 'UI_NEW_C\n');
});

test('navigation cancels running compiler and never mutates detached output', 'compiler', async s => {
  await select(s, 'Compiler mode', 'c');
  await fill(s, SOURCE, loop('UI_DETACHED_C'));
  const index = await start(s, 'Compile & run', 'UI_DETACHED_C');
  await s.evaluate(`window.__detachedOutput=${get(OUTPUT)}; window.__detachedMutations=0; new MutationObserver(records=>window.__detachedMutations+=records.length).observe(window.__detachedOutput,{subtree:true,childList:true,characterData:true});`);
  await panel(s, 'editor');
  await s.waitFor(`window.__uiRegression.runs[${index}].result?.killed === true`);
  await settle(s);
  assert.equal(await s.evaluate('window.__detachedOutput.isConnected'), false);
  assert.equal(await s.evaluate('window.__detachedMutations'), 0);
  assert.equal(await s.evaluate(`!!${get(OUTPUT)}`), false);
  assert.equal(await s.evaluate(`window.__uiRegression.runs[${index}].kills`), 1);
});

test('SINGU generate during execution discards stale result then builds', 'assistant', async s => {
  await fill(s, GENERATED, interpreterLoop('UI_OLD_SINGU'));
  const index = await start(s, 'Build & run', 'UI_OLD_SINGU');
  await fill(s, PROMPT, 'a ring buffer with capacity 8');
  await click(s, 'Generate C');
  const generated = await s.evaluate(`${get(GENERATED)}.value`);
  assert.notEqual(generated, interpreterLoop('UI_OLD_SINGU'));
  assert.ok(generated.length > 100, 'Generate must produce substantive C');
  const visible = await s.evaluate(`({code:${get(GENERATED)}.value, out:${get(SINGU_OUTPUT)}.textContent, status:document.querySelector('#panel-assistant [role="status"]').textContent})`);
  await s.waitFor(`window.__uiRegression.runs[${index}].result?.killed === true`);
  await settle(s);
  assert.deepEqual(await s.evaluate(`({code:${get(GENERATED)}.value, out:${get(SINGU_OUTPUT)}.textContent, status:document.querySelector('#panel-assistant [role="status"]').textContent})`), visible);
  assert.equal(visible.out, '');
  assert.equal(await s.evaluate(`(${button('Kill')}).disabled`), true);
  const record = await run(s, 'Build & run');
  assert.equal(record.result.ok, true, JSON.stringify(record.result));
  assert.ok(record.result.output.length > 0);
  assert.equal(await output(s, SINGU_OUTPUT), record.result.output);
});

test('SINGU Kill ownership and exact interpreter handoff to M2', 'compiler', async s => {
  await select(s, 'Compiler mode', 'interpreter');
  await fill(s, SOURCE, interpreterLoop('UI_OWNER_M2'));
  const old = await start(s, 'Compile & run', 'UI_OWNER_M2');
  await panel(s, 'assistant');
  await s.waitFor(`window.__uiRegression.runs[${old}].result?.killed === true`);
  await fill(s, GENERATED, interpreterLoop('UI_OWNER_SINGU'));
  await start(s, 'Build & run', 'UI_OWNER_SINGU');
  await click(s, 'Kill');
  const killed = await finished(s, 'Build & run');
  assert.equal(killed.result.killed, true);
  assert.equal(killed.kills, 1);
  assert.notEqual(killed.owner, await s.evaluate(`window.__uiRegression.runs[${old}].owner`));
  await fill(s, PROMPT, 'a 64-bit bitset with set clear and count');
  await click(s, 'Generate C');
  const code = await s.evaluate(`${get(GENERATED)}.value`);
  // Prove a live handoff, not a fast program that finished before the click.
  const transferred = interpreterLoop('UI_LIVE_HANDOFF');
  await fill(s, GENERATED, transferred);
  const handoff = await start(s, 'Build & run', 'UI_LIVE_HANDOFF');
  await click(s, 'Send to M2 runtime');
  await s.waitFor(`!!${get(SOURCE)}`);
  await s.waitFor(`window.__uiRegression.runs[${handoff}].result?.killed === true`);
  assert.equal(await s.evaluate('location.hash'), '#compiler');
  assert.equal(await s.evaluate(`${get(SOURCE)}.value`), transferred);
  assert.equal(await s.evaluate(`${get('[aria-label="Compiler mode"]')}.value`), 'interpreter');
  assert.equal(await s.evaluate(`${get('[aria-label="Language standard"]')}.disabled`), true);
  await fill(s, SOURCE, code);
  const record = await run(s);
  assert.equal(record.result.ok, true, JSON.stringify(record.result));
  assert.equal(await output(s), record.result.output);
  assert.notEqual(record.owner, killed.owner);
  assert.equal(await s.evaluate(`window.__uiRegression.runs[${handoff}].kills`), 1);
});

for (const [name, initial, selector, value] of [
  ['compiler source', 'compiler', SOURCE, '// keyboard '],
  ['SINGU brief', 'assistant', PROMPT, 'keyboard '],
  ['password input', 'mesh', '#relay-pass', 'throwaway-'],
]) {
  test(`real Backslash stays in ${name}; body dial and composition`, initial, async s => {
    await fill(s, selector, value);
    await key(s, '\\', 'Backslash', 220, '\\');
    assert.equal(await s.evaluate(`${get(selector)}.value`), value + '\\');
    assert.equal(await s.evaluate(`!!${get(DIAL)}`), false);
    const typed = await s.evaluate('window.__uiRegression.keys.at(-1)');
    assert.equal(typed.trusted, true, 'Must exercise a real CDP browser keystroke');
    assert.equal(typed.prevented, false);
    await s.evaluate('document.activeElement.blur(); document.body.focus()');
    await key(s, '\\', 'Backslash', 220, '\\');
    await s.waitFor(`!!${get(DIAL)}`);
    assert.equal(await s.evaluate('window.__uiRegression.keys.at(-1).prevented'), true);
    await key(s, 'Escape', 'Escape', 27);
    await s.waitFor(`!${get(DIAL)}`);
    const composition = await s.evaluate(`(() => { document.activeElement.blur(); const e=new KeyboardEvent('keydown',{key:'\\\\',code:'Backslash',isComposing:true,bubbles:true,cancelable:true}); document.body.dispatchEvent(e); return {prevented:e.defaultPrevented,dial:!!${get(DIAL)}}; })()`);
    assert.deepEqual(composition, { prevented: false, dial: false });
  });
}

test('ghost timer paints durable RGA; next user keystroke preserves peer edit', 'editor', async s => {
  await fill(s, EDITOR, 'UI_GHOST_BASE');
  await waitDurable(s, 'UI_GHOST_BASE');
  await click(s, 'Add virtual peer');
  const deadline = Date.now() + 15000;
  let persisted;
  do {
    persisted = await durable(s);
    if (persisted.ghostOps > 0) break;
    await settle(s, 100);
  } while (Date.now() < deadline);
  assert.ok(persisted.ghostOps > 0, 'The actual peer timer never persisted an insertion');
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), persisted.text, 'Ghost edit persisted but textarea was stale');
  await key(s, 'k', 'KeyK', 75, undefined, 2);
  await s.waitFor(`!!${get('[aria-label="Command"]')}`);
  await fill(s, '[aria-label="Command"]', 'Remove a virtual peer');
  await key(s, 'Enter', 'Enter', 13);
  await s.waitFor(`!!${get(EDITOR)} && !document.querySelector('.palette[data-open="true"]')`);
  const before = await durable(s);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), before.text);
  await s.evaluate(`${get(EDITOR)}.focus(); ${get(EDITOR)}.setSelectionRange(${get(EDITOR)}.value.length,${get(EDITOR)}.value.length)`);
  await s.send('Input.insertText', { text: '\nUI_USER_AFTER_GHOST' });
  const after = await waitDurable(s, before.text + '\nUI_USER_AFTER_GHOST');
  assert.equal(after.ghostOps, before.ghostOps);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), after.text);
});

test('empty durable document and empty snapshot survive real reloads', 'editor', async s => {
  await fill(s, EDITOR, 'UI_EMPTY_BEFORE');
  await waitDurable(s, 'UI_EMPTY_BEFORE');
  await fill(s, EDITOR, '');
  await waitDurable(s, '');
  await storage(s, `await store.compact(${q(DOC_ID)}, '');`);
  await reloadEditor(s);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), '', 'A fully tombstoned log must not resurrect welcome text');
  await storage(s, `await store.replaceOps(${q(DOC_ID)}, [], '');`);
  await reloadEditor(s);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), '', 'An intentionally empty snapshot must not be treated as absent');
  const value = await durable(s);
  assert.equal(value.snapshot.text, '');
  assert.equal(value.text, '');
});

test('snapshot plus suffix edits recover through isolated IndexedDB', 'editor', async s => {
  for (const snapshotOnly of [false, true]) {
    const base = snapshotOnly ? 'UI_SNAPSHOT_ONLY\n' : 'UI_COMPACT_BASE\n';
    await fill(s, EDITOR, base);
    await waitDurable(s, base);
    await storage(s, snapshotOnly
      ? `await store.replaceOps(${q(DOC_ID)}, [], ${q(base)});`
      : `await store.compact(${q(DOC_ID)}, ${q(base)});`);
    if (snapshotOnly) await reloadEditor(s);
    const saved = await durable(s);
    assert.equal(saved.snapshot.text, base);
    assert.equal(saved.text, base);
    assert.ok(saved.count > 0, 'Recovery must retain or reseed causal identities before later edits');
    await s.evaluate(`${get(EDITOR)}.focus(); ${get(EDITOR)}.setSelectionRange(${get(EDITOR)}.value.length,${get(EDITOR)}.value.length)`);
    await s.send('Input.insertText', { text: 'UI_SUFFIX_AFTER_SNAPSHOT' });
    const expected = base + 'UI_SUFFIX_AFTER_SNAPSHOT';
    await waitDurable(s, expected);
    await reloadEditor(s);
    assert.equal(await s.evaluate(`${get(EDITOR)}.value`), expected);
    await waitDurable(s, expected);
  }
});

test('pending OPFS writes drain before UI Compact snapshots and reload', 'editor', async s => {
  const compact = async () => {
    await key(s, 'k', 'KeyK', 75, undefined, 2);
    await s.waitFor(`!!document.querySelector('.palette[data-open="true"]')`);
    await fill(s, '[aria-label="Command"]', 'Compact the op log into a snapshot');
    assert.equal(await s.evaluate(`document.querySelector('#palette-list [aria-selected="true"] .p-name')?.textContent`), 'Compact the op log into a snapshot');
    await key(s, 'Enter', 'Enter', 13);
    await s.waitFor(`!document.querySelector('.palette[data-open="true"]')`);
  };
  const append = async text => {
    await s.evaluate(`${get(EDITOR)}.focus(); ${get(EDITOR)}.setSelectionRange(${get(EDITOR)}.value.length,${get(EDITOR)}.value.length)`);
    await s.send('Input.insertText', { text });
  };
  await fill(s, EDITOR, 'abc');
  await waitDurable(s, 'abc');
  await compact();
  await s.waitFor(`document.querySelector('.toasts')?.textContent.includes('Saved 3-character snapshot;')`);
  const baseline = await durable(s);
  assert.equal(baseline.snapshot.text, 'abc');

  await s.evaluate(`(async () => {
    const { openOpfsMirror } = await import(new URL('src/storage/opfs.js', document.baseURI).href);
    const mirror = await openOpfsMirror(), status = await mirror.status(${q(DOC_ID)});
    if (!status.supported || !status.available || status.error) throw new Error('Actual writable OPFS required: ' + JSON.stringify(status));
    const { openLocalStore } = await import(new URL('src/storage/db.js', document.baseURI).href);
    const store = await openLocalStore();
    let storeProto;
    try {
      if (!store.persistent || !store.db) throw new Error('Actual IndexedDB required');
      storeProto = Object.getPrototypeOf(store);
    } finally { store.close(); }
    const writeProto = FileSystemWritableFileStream.prototype;
    const writeDescriptor = Object.getOwnPropertyDescriptor(writeProto, 'write');
    const compactDescriptor = Object.getOwnPropertyDescriptor(storeProto, 'compact');
    if (!writeDescriptor?.configurable || !compactDescriptor?.configurable) throw new Error('Storage methods cannot be observed safely');
    const gate = window.__pendingWrite = { writes: [], compactions: [], mirror };
    for (const suffix of ['D', 'EF']) {
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      const record = { suffix, entered: false, released: false, forwarded: false, error: null, ops: [], wait,
        release() { record.released = true; release(); } };
      gate.writes.push(record);
    }
    gate.restore = () => {
      // Also release gates that were never entered: a failed assertion must not
      // leave a native writable suspended when the throwaway tab is closed.
      for (const record of gate.writes) record.release();
      Object.defineProperty(writeProto, 'write', writeDescriptor);
      Object.defineProperty(storeProto, 'compact', compactDescriptor);
      return [[writeProto, 'write', writeDescriptor], [storeProto, 'compact', compactDescriptor]].every(([proto, name, saved]) => {
        const restored = Object.getOwnPropertyDescriptor(proto, name);
        return ['value', 'writable', 'enumerable', 'configurable'].every(key => restored[key] === saved[key]);
      });
    };
    try {
      Object.defineProperty(writeProto, 'write', { ...writeDescriptor, value: async function (...values) {
        let batch;
        try { batch = typeof values[0] === 'string' ? JSON.parse(values[0]) : null; } catch { /* Not a JSON batch. */ }
        const record = Number.isInteger(batch?.seq) && Array.isArray(batch.ops)
          ? gate.writes.find(r => !r.entered && batch.ops.every(op => op.t === 'ins') && batch.ops.map(op => op.c).join('') === r.suffix)
          : null;
        if (!record) return writeDescriptor.value.apply(this, values);
        record.entered = true; record.ops = batch.ops;
        await record.wait;
        try {
          const result = await writeDescriptor.value.apply(this, values);
          record.forwarded = true;
          return result;
        } catch (err) { record.error = err.message; throw err; }
      } });
      // A pass-through observer, not a substitute compact/saveDoc operation.
      Object.defineProperty(storeProto, 'compact', { ...compactDescriptor, value: async function (...values) {
        const record = { docId: values[0], text: values[1], completed: false };
        gate.compactions.push(record);
        const result = await compactDescriptor.value.apply(this, values);
        record.completed = true;
        return result;
      } });
    } catch (err) { gate.restore(); delete window.__pendingWrite; throw err; }
  })()`);
  try {
    await append('D');
    await s.waitFor('window.__pendingWrite.writes[0].entered');
    assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcD');
    await compact(); // Real palette action stays on the editor while it awaits storage.
    await append('EF'); // Enqueue another real input after Compact began draining.
    assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcDEF');
    const pending = async (text, count) => {
      await settle(s, 250); // Observe a blocked action, not a guessed disk latency.
      assert.equal(await s.evaluate('window.__pendingWrite.compactions.length'), 0, 'UI Compact reached snapshot storage while an OPFS batch was still gated');
      const saved = await durable(s);
      assert.equal(saved.snapshot.text, 'abc', 'A pending write must not advance the compact snapshot');
      assert.equal(saved.text, text);
      assert.equal(saved.buffered, 0);
      assert.equal(saved.count, count);
      assert.equal(await s.evaluate(`document.querySelector('.toasts')?.textContent.includes('Saved 6-character snapshot;') || false`), false, 'Compact reported completion before pending writes drained');
    };
    await pending('abc', baseline.count);
    assert.equal(await s.evaluate('window.__pendingWrite.writes[1].entered'), false, 'The suffix overtook the serialized first write');
    await s.evaluate('window.__pendingWrite.writes[0].release()');
    await s.waitFor('window.__pendingWrite.writes[1].entered');
    await waitDurable(s, 'abcD');
    // A one-time await of the original Promise is insufficient: the suffix
    // queued while it was outstanding must drain before the snapshot too.
    await pending('abcD', baseline.count + 1);
    await s.evaluate('window.__pendingWrite.writes[1].release()');
    await s.waitFor('window.__pendingWrite.compactions.length === 1 && window.__pendingWrite.compactions[0].completed');
    await s.waitFor(`document.querySelector('.toasts')?.textContent.includes('Saved 6-character snapshot;')`);
    const saved = await waitDurable(s, 'abcDEF');
    assert.equal(saved.snapshot.text, 'abcDEF');
    assert.equal(saved.count, baseline.count + 3, 'Compact must retain every causal operation');
    assert.deepEqual(await s.evaluate('window.__pendingWrite.compactions'), [{ docId: DOC_ID, text: 'abcDEF', completed: true }]);
    const mirrored = await s.evaluate(`(async () => {
      const gate = window.__pendingWrite, batches = await gate.mirror.readBatches(${q(DOC_ID)});
      const stored = new Set(batches.ops.map(op => JSON.stringify(op)));
      return { corrupt: batches.corrupt, writes: gate.writes.map(r => ({ forwarded: r.forwarded, error: r.error,
        persisted: r.ops.length > 0 && r.ops.every(op => stored.has(JSON.stringify(op))) })) };
    })()`);
    assert.equal(mirrored.corrupt, 0);
    assert.deepEqual(mirrored.writes, ['D', 'EF'].map(() => ({ forwarded: true, error: null, persisted: true })), 'Both original native writes must commit to the real OPFS files');
  } finally {
    const cleanup = await s.evaluate(`(() => {
      const gate = window.__pendingWrite;
      const restored = gate.restore(), released = gate.writes.every(r => r.released);
      delete window.__pendingWrite;
      return { restored, released, removed: !Object.hasOwn(window, '__pendingWrite') };
    })()`);
    assert.deepEqual(cleanup, { restored: true, released: true, removed: true }, 'Restore the exact storage descriptors and release every gate even on failure');
  }
  await reloadEditor(s);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcDEF', 'Real reload must not prefer an old abc log over the full snapshot');
  const recovered = await waitDurable(s, 'abcDEF');
  assert.equal(recovered.snapshot.text, 'abcDEF');
  assert.equal(recovered.count, baseline.count + 3);
});

test('causal persistence: rejected IndexedDB D batch retries on native EF edit', 'editor', async s => {
  const compact = async () => {
    await key(s, 'k', 'KeyK', 75, undefined, 2);
    await s.waitFor(`!!document.querySelector('.palette[data-open="true"]')`);
    await fill(s, '[aria-label="Command"]', 'Compact the op log into a snapshot');
    assert.equal(await s.evaluate(`document.querySelector('#palette-list [aria-selected="true"] .p-name')?.textContent`), 'Compact the op log into a snapshot');
    await key(s, 'Enter', 'Enter', 13);
    await s.waitFor(`!document.querySelector('.palette[data-open="true"]')`);
  };
  const append = async text => {
    await s.evaluate(`${get(EDITOR)}.focus(); ${get(EDITOR)}.setSelectionRange(${get(EDITOR)}.value.length,${get(EDITOR)}.value.length)`);
    await s.send('Input.insertText', { text });
  };
  await fill(s, EDITOR, 'abc');
  await waitDurable(s, 'abc');
  await compact();
  await s.waitFor(`document.querySelector('.toasts')?.textContent.includes('Saved 3-character snapshot;')`);
  const baseline = await durable(s);
  assert.equal(baseline.snapshot.text, 'abc');

  const warnings = [];
  const observeWarning = params => {
    if (params.type === 'warning' && params.args[0]?.value === '[storage] append failed'
      && params.args[1]?.description?.includes('UI_INJECTED_D_APPEND_ONCE')) warnings.push(params.args[1].description);
  };
  s.on('Runtime.consoleAPICalled', observeWarning);
  await s.evaluate(`(async () => {
    const { openLocalStore } = await import(new URL('src/storage/db.js', document.baseURI).href);
    const store = await openLocalStore();
    let proto;
    try {
      if (!store.persistent || !store.db) throw new Error('Actual IndexedDB required');
      proto = Object.getPrototypeOf(store);
    } finally { store.close(); }
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'appendOps');
    if (!descriptor?.configurable) throw new Error('appendOps cannot be observed safely');
    const { openOpfsMirror } = await import(new URL('src/storage/opfs.js', document.baseURI).href);
    const mirror = await openOpfsMirror(), status = await mirror.status(${q(DOC_ID)});
    if (!status.supported || !status.available || status.error) throw new Error('Actual writable OPFS required: ' + JSON.stringify(status));
    const probe = window.__retryAppend = { attempts: [], rejections: 0, mirror };
    probe.restore = () => {
      Object.defineProperty(proto, 'appendOps', descriptor);
      const restored = Object.getOwnPropertyDescriptor(proto, 'appendOps');
      return ['value', 'writable', 'enumerable', 'configurable'].every(key => restored[key] === descriptor[key]);
    };
    try {
      Object.defineProperty(proto, 'appendOps', { ...descriptor, value: async function (...values) {
        const [docId, ops] = values;
        const suffix = Array.isArray(ops) && ops.every(op => op.t === 'ins') ? ops.map(op => op.c).join('') : null;
        if (docId !== ${q(DOC_ID)} || !['D', 'EF'].includes(suffix)) return descriptor.value.apply(this, values);
        const record = { suffix, ops, rejected: false, forwarded: false, completed: false, result: null };
        probe.attempts.push(record);
        if (suffix === 'D' && probe.rejections === 0) {
          probe.rejections++;
          record.rejected = true;
          // Reject before the original method: no transaction or fake success.
          throw new Error('UI_INJECTED_D_APPEND_ONCE');
        }
        record.forwarded = true;
        record.result = await descriptor.value.apply(this, values);
        record.completed = true;
        return record.result;
      } });
    } catch (err) { probe.restore(); delete window.__retryAppend; throw err; }
  })()`);
  try {
    await append('D');
    await s.waitFor('window.__retryAppend.rejections === 1');
    assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcD');
    await settle(s, 250); // The rejected batch stays queued, not autonomously retried.
    assert.equal(warnings.length, 1, 'The intentionally injected rejection must reach the normal storage warning handler');
    const rejected = await durable(s);
    assert.equal(rejected.text, 'abc');
    assert.equal(rejected.buffered, 0);
    assert.equal(rejected.count, baseline.count);
    assert.equal(rejected.snapshot.text, 'abc');
    assert.equal(await s.evaluate(`document.querySelector('.editor-status').textContent.includes(${q(`${baseline.count} ops in IndexedDB`)})`), true, 'A rejected append must not increment the durable op counter');
    assert.deepEqual(await s.evaluate('window.__retryAppend.attempts.map(({suffix,rejected,forwarded,completed,result}) => ({suffix,rejected,forwarded,completed,result}))'), [
      { suffix: 'D', rejected: true, forwarded: false, completed: false, result: null },
    ]);
    assert.equal(await s.evaluate(`(async () => {
      const probe = window.__retryAppend, mirrored = await probe.mirror.readBatches(${q(DOC_ID)});
      return mirrored.corrupt === 0 && mirrored.ops.some(op => JSON.stringify(op) === JSON.stringify(probe.attempts[0].ops[0]));
    })()`), true, 'The failed IDB batch must already exist in the real OPFS write-ahead mirror');

    await append('EF');
    assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcDEF');
    const committed = await waitDurable(s, 'abcDEF');
    assert.equal(committed.count, baseline.count + 3, 'Retry must write D exactly once, then E and F');
    await s.waitFor('window.__retryAppend.attempts.length === 3 && window.__retryAppend.attempts[2].completed');
    const attempts = await s.evaluate('window.__retryAppend.attempts');
    assert.deepEqual(attempts.map(({suffix,rejected,forwarded,completed,result}) => ({suffix,rejected,forwarded,completed,result})), [
      { suffix: 'D', rejected: true, forwarded: false, completed: false, result: null },
      { suffix: 'D', rejected: false, forwarded: true, completed: true, result: 1 },
      { suffix: 'EF', rejected: false, forwarded: true, completed: true, result: 2 },
    ]);
    assert.deepEqual(attempts[1].ops, attempts[0].ops, 'Retry must retain the original causal D identity');
    assert.deepEqual(attempts[2].ops[0].o, attempts[1].ops[0].id);
    assert.deepEqual(attempts[2].ops[1].o, attempts[2].ops[0].id);
    const storedSuffix = await storage(s, `return (await store.loadOps(${q(DOC_ID)})).slice(${baseline.count});`);
    assert.deepEqual(storedSuffix, [...attempts[1].ops, ...attempts[2].ops], 'Every reported success must be an actual committed IndexedDB write');
    assert.equal(await s.evaluate(`document.querySelector('.editor-status').textContent.includes(${q(`${baseline.count + 3} ops in IndexedDB`)})`), true);
    await compact();
    await s.waitFor(`document.querySelector('.toasts')?.textContent.includes('Saved 6-character snapshot;')`);
    const saved = await waitDurable(s, 'abcDEF');
    assert.equal(saved.snapshot.text, 'abcDEF');
    assert.equal(saved.count, baseline.count + 3);
    assert.equal(await s.evaluate('window.__retryAppend.rejections'), 1);
    assert.equal(warnings.length, 1);
  } finally {
    const cleanup = await s.evaluate(`(() => {
      const restored = window.__retryAppend.restore();
      delete window.__retryAppend;
      return { restored, removed: !Object.hasOwn(window, '__retryAppend') };
    })()`);
    s.listeners.set('Runtime.consoleAPICalled', (s.listeners.get('Runtime.consoleAPICalled') || []).filter(handler => handler !== observeWarning));
    assert.deepEqual(cleanup, { restored: true, removed: true }, 'Restore the exact original appendOps descriptor even on failure');
  }
  await reloadEditor(s);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcDEF');
  const recovered = await waitDurable(s, 'abcDEF');
  assert.equal(recovered.snapshot.text, 'abcDEF');
  assert.equal(recovered.count, baseline.count + 3);
});

test('causal persistence: real mesh snapshot seeds before pending storage and native suffix', 'editor', async s => {
  await storage(s, `await store.replaceOps(${q(DOC_ID)}, [], '');`);
  await s.evaluate(`(async () => {
    const { openOpfsMirror } = await import(new URL('src/storage/opfs.js', document.baseURI).href);
    await (await openOpfsMirror()).removeDoc(${q(DOC_ID)});
  })()`);
  await reloadEditor(s);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), '');
  const empty = await durable(s);
  assert.equal(empty.count, 0);
  assert.equal(empty.snapshot.text, '');

  await s.evaluate(`(async () => {
    const { openLocalStore } = await import(new URL('src/storage/db.js', document.baseURI).href);
    const store = await openLocalStore();
    let proto;
    try {
      if (!store.persistent || !store.db) throw new Error('Actual IndexedDB required');
      proto = Object.getPrototypeOf(store);
    } finally { store.close(); }
    const appendDescriptor = Object.getOwnPropertyDescriptor(proto, 'appendOps');
    const replaceDescriptor = Object.getOwnPropertyDescriptor(proto, 'replaceOps');
    if (!appendDescriptor?.configurable || !replaceDescriptor?.configurable) throw new Error('Storage methods cannot be observed safely');
    const { Mesh } = await import(new URL('src/collab/mesh.js', document.baseURI).href);
    const { RGA } = await import(new URL('src/crdt/rga.js', document.baseURI).href);
    const target = document.querySelector('#footer-build').textContent.match(/peer-[0-9a-f]+$/)?.[0];
    if (!target) throw new Error('Actual peer identity missing from UI');
    const donor = new RGA('ui-snapshot-peer');
    donor.localInsert(0, 'abc'); donor.trimLog(0);
    if (donor.log.length || donor.logTrimmed !== 3) throw new Error('Donor must have genuinely trimmed its causal log');
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const probe = window.__meshSnapshot = { calls: [], replacements: 0, entered: false, released: false, target, peer: null,
      release() { probe.released = true; release(); } };
    probe.restore = () => {
      probe.release();
      probe.peer?.close();
      Object.defineProperty(proto, 'appendOps', appendDescriptor);
      Object.defineProperty(proto, 'replaceOps', replaceDescriptor);
      return [['appendOps', appendDescriptor], ['replaceOps', replaceDescriptor]].every(([name, saved]) => {
        const restored = Object.getOwnPropertyDescriptor(proto, name);
        return ['value', 'writable', 'enumerable', 'configurable'].every(key => restored[key] === saved[key]);
      });
    };
    try {
      Object.defineProperty(proto, 'appendOps', { ...appendDescriptor, value: async function (...values) {
        if (values[0] !== ${q(DOC_ID)}) return appendDescriptor.value.apply(this, values);
        const record = { ops: values[1], forwarded: false, completed: false, result: null };
        probe.calls.push(record);
        if (!probe.entered && record.ops.every(op => op.t === 'ins') && record.ops.map(op => op.c).join('') === 'abc') {
          probe.entered = true;
          await wait;
        }
        record.forwarded = true;
        record.result = await appendDescriptor.value.apply(this, values);
        record.completed = true;
        return record.result;
      } });
      Object.defineProperty(proto, 'replaceOps', { ...replaceDescriptor, value: function (...values) {
        probe.replacements++;
        return replaceDescriptor.value.apply(this, values);
      } });
      // Separate real BroadcastChannel carrier: never call app handlers or expose its state.
      probe.peer = new Mesh({ room: ${q(DOC_ID)}, id: donor.replica, name: 'Snapshot regression peer' }).start();
      if (!probe.peer.available) throw new Error('Actual BroadcastChannel required');
      probe.peer.send('sync-response', { doc: ${q(DOC_ID)}, to: target, ops: donor.log, text: donor.text() });
    } catch (err) { probe.restore(); delete window.__meshSnapshot; throw err; }
  })()`);
  try {
    await s.waitFor('window.__meshSnapshot.entered');
    assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abc', 'Peer text must be adopted synchronously before its durable append completes');
    const pending = await durable(s);
    assert.equal(pending.text, '');
    assert.equal(pending.count, 0);
    assert.equal(pending.snapshot.text, '');
    await s.evaluate(`${get(EDITOR)}.focus(); ${get(EDITOR)}.setSelectionRange(3,3)`);
    await s.send('Input.insertText', { text: 'DEF' });
    assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcDEF');
    await settle(s, 250);
    assert.deepEqual(await s.evaluate('({calls:window.__meshSnapshot.calls.length, replacements:window.__meshSnapshot.replacements, forwarded:window.__meshSnapshot.calls[0].forwarded})'),
      { calls: 1, replacements: 0, forwarded: false }, 'Snapshot seeds must use the normal serialized append path, without replacing the current RGA or durable log');
    assert.equal((await durable(s)).count, 0, 'The native suffix must not overtake its pending seed operations');
    await s.evaluate('window.__meshSnapshot.release()');
    const saved = await waitDurable(s, 'abcDEF');
    assert.equal(saved.count, 6);
    assert.equal(saved.snapshot.text, '', 'Regular persist(seedOps) must not replace the recovery snapshot');
    await s.waitFor('window.__meshSnapshot.calls.length === 2 && window.__meshSnapshot.calls.every(r => r.completed)');
    const records = await s.evaluate('({calls:window.__meshSnapshot.calls, replacements:window.__meshSnapshot.replacements, target:window.__meshSnapshot.target})');
    assert.equal(records.replacements, 0);
    assert.deepEqual(records.calls.map(r => ({text:r.ops.map(op => op.c).join(''),forwarded:r.forwarded,completed:r.completed,result:r.result})), [
      { text: 'abc', forwarded: true, completed: true, result: 3 },
      { text: 'DEF', forwarded: true, completed: true, result: 3 },
    ]);
    const ops = records.calls.flatMap(r => r.ops);
    assert.equal(ops[0].o, null);
    assert.ok(ops.every(op => op.id[1] === records.target), 'Seeds and suffix must retain the current local replica identity');
    for (let i = 1; i < ops.length; i++) assert.deepEqual(ops[i].o, ops[i - 1].id);
    assert.deepEqual(await storage(s, `return await store.loadOps(${q(DOC_ID)});`), ops, 'No fake successful append or replacement may stand in for real durable seeds');
  } finally {
    const cleanup = await s.evaluate(`(() => {
      const probe = window.__meshSnapshot, restored = probe.restore(), released = probe.released;
      delete window.__meshSnapshot;
      return { restored, released, removed: !Object.hasOwn(window, '__meshSnapshot') };
    })()`);
    assert.deepEqual(cleanup, { restored: true, released: true, removed: true }, 'Release storage, close the real peer and restore both exact descriptors even on failure');
  }
  await reloadEditor(s);
  assert.equal(await s.evaluate(`${get(EDITOR)}.value`), 'abcDEF');
  const recovered = await waitDurable(s, 'abcDEF');
  assert.equal(recovered.count, 6);
  assert.equal(recovered.snapshot.text, '');
});

test('engine enter/leave disposes GPU ownership, rAF and timers repeatedly', 'editor', async s => {
  const baseline = await s.evaluate('window.__uiRegression.intervals.size');
  for (let cycle = 0; cycle < 3; cycle++) {
    await panel(s, 'engine');
    const availability = await s.waitFor(`(() => { const text=document.querySelector('#main .canvas-overlay')?.textContent || ''; if(text.startsWith('engine unavailable:')) return {error:text}; return window.__uiRegression.renderers.length === ${cycle + 1} && window.__uiRegression.renderers.at(-1).frames > 0 ? {drawing:true} : false; })()`, { timeoutMs: 60000 });
    assert.equal(availability.drawing, true, 'Real engine startup failed: ' + JSON.stringify(availability));
    const model = await s.waitFor("(() => { const r=window.__uiRegression.renderers.at(-1); const text=document.querySelector('#main').textContent; return text.includes('sample model failed to load:') ? {error:text.slice(-1600)} : r.instance.model ? {loaded:true} : false; })()", { timeoutMs: 60000 });
    assert.equal(model.loaded, true, 'Bundled glTF must actually load: ' + JSON.stringify(model));
    const active = await s.evaluate('({timers:window.__uiRegression.intervals.size, gpu:window.__uiRegression.gpu.get(window.__uiRegression.renderers.at(-1).gl)?.size || 0})');
    assert.equal(active.timers, baseline + 2, 'Exactly two engine telemetry timers should be owned');
    assert.ok(active.gpu > 0, 'The real engine must allocate and draw, not take a fallback path');
    await panel(s, 'editor');
    const frames = await s.evaluate('window.__uiRegression.renderers.at(-1).frames');
    await settle(s, 1100); // Cross both the 500 ms and 1000 ms telemetry periods.
    const retired = await s.evaluate(`window.__uiRegression.renderers.map(r => ({disposals:r.disposals, frames:r.frames, running:r.instance.running, gl:r.instance.gl, model:r.instance.model, rafPending:window.__uiRegression.rafs.has(r.instance.raf), gpu:window.__uiRegression.gpu.get(r.gl)?.size || 0}))`);
    for (const record of retired) {
      assert.equal(record.disposals, 1, 'One disposal per engine visit');
      assert.equal(record.running, false);
      assert.equal(record.gl, null);
      assert.equal(record.model, null);
      assert.equal(record.rafPending, false);
      assert.equal(record.gpu, 0, 'Renderer-owned WebGL resources leaked');
    }
    assert.equal(retired.at(-1).frames, frames, 'Detached renderer continued receiving frames');
    assert.equal(await s.evaluate('window.__uiRegression.intervals.size'), baseline, 'Engine timers accumulated between visits');
  }
});

async function main() {
  if (!Number.isFinite(TIMEOUT) || TIMEOUT < 1000) throw new Error('--timeout-ms must be at least 1000');
  const selected = tests.filter(t => !args.only || t.name.toLowerCase().includes(String(args.only).toLowerCase()));
  if (!selected.length) throw new Error(`No tests match --only=${args.only}`);
  let site, browser, files, url;
  const results = [];
  try {
    if (/^https?:\/\//.test(args.url || '')) url = new URL(args.url).href;
    else {
      // Ask the existing helper for a free port, then hand that port to the real
      // project server so its CSP/COOP/COEP, MIME and compression are exercised.
      const lease = await serveProject();
      await new Promise((resolve, reject) => lease.server.close(err => err ? reject(err) : resolve()));
      site = await startProjectServer({ port: lease.port });
      site.proc.stdout.resume(); site.proc.stderr.resume();
      url = new URL(args.url || '/', site.origin).href;
    }
    await readdir(tmpdir()); // Verify upload/profile parent before mkdtemp.
    files = await mkdtemp(join(tmpdir(), 'singularity-ui-upload-'));
    await writeFile(join(files, 'helper.h'), '#ifndef UI_HELPER_H\n#define UI_HELPER_H\nint helper(int value);\n#endif\n');
    await writeFile(join(files, 'helper.c'), '#include "helper.h"\nint helper(int value) { return value * 2; }\n');
    browser = await Browser.launchOnce({ headless: !!args.headless, width: 1280, height: 900, scale: 1, softwareGl: true,
      extraArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    console.log(`# UI regressions: ${url}`);
    console.log(`# ${(await browser.send('Browser.getVersion')).product}; ${args.headless ? 'headless' : 'windowed'}; isolated throwaway profile; real workers/IndexedDB/WebGL2`);
    console.log(`1..${selected.length}`);
    for (const t of selected) {
      const began = Date.now();
      let s, failure;
      try {
        s = await browser.newSession();
        await monitor(s);
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${browserObservers.toString()})()` });
        await foreground(s);
        const target = new URL(url); target.hash = t.initial;
        await s.navigate(target.href);
        await foreground(s);
        await s.waitFor(`!!${get(`#tab-${t.initial}`)} && !!${get(`#panel-${t.initial} h1`)}`, { timeoutMs: 60000 });
        assert.equal(await s.evaluate('document.visibilityState'), 'visible', 'Hidden rAF is not a valid boot test');
        await hooks(s);
        await t.fn(s, files);
        await settle(s, 100);
      } catch (err) {
        failure = err.stack || String(err);
      } finally {
        if (s) {
          const errors = [...s.consoleErrors, ...s.pageErrors];
          if (errors.length) failure = (failure ? failure + '\n' : '') + 'Browser console/page errors:\n' + errors.join('\n');
          if (failure) {
            try {
              console.error('# UI at failure: ' + q(await s.evaluate(`({hash:location.hash, visible:document.visibilityState, title:document.querySelector('#main h1')?.textContent, text:document.querySelector('#main')?.textContent.slice(-1800), runs:window.__uiRegression?.runs.map(r=>({owner:r.owner,phases:r.phases,kills:r.kills,result:r.result}))})`)));
              if (s.networkFailures.length) console.error('# Failed browser/worker requests: ' + q(s.networkFailures));
            } catch { /* A crashed/detached page already has a meaningful error. */ }
          }
          await s.closeTab();
          browser.sessions.delete(s.sessionId);
          for (const id of s.childSessions) browser.sessions.delete(id);
        }
      }
      const result = { name: t.name, ok: !failure, ms: Date.now() - began, ...(failure ? { error: failure } : {}) };
      results.push(result);
      console.log(`${failure ? 'not ok' : 'ok'} ${results.length} - ${t.name} (${result.ms} ms)`);
      if (failure) console.error(failure);
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`# ${results.length - failed} passed, ${failed} failed; no skipped feature tests`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await browser?.close();
    if (site) {
      await new Promise(resolve => {
        if (site.proc.exitCode !== null) return resolve();
        site.proc.once('exit', resolve); site.proc.kill();
      });
      site.proc.stdout.destroy(); site.proc.stderr.destroy();
    }
    if (files) await rm(files, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch(err => { console.error(err.stack || String(err)); process.exitCode = 1; });
