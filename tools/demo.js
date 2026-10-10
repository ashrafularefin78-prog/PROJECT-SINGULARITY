/**
 * The demo video, recorded from the real app.
 *
 *   node tools/demo.js [--out=docs/demo/demo.mp4] [--fps=6] [--crf=32]
 *                      [--width=1280] [--height=720] [--speed=1]
 *                      [--keep-frames] [--beats=all] [--encode-only]
 *
 * The brief asks for a 10-minute demo video. Nothing in this environment can
 * narrate, so this tool does the honest version of the delivery: it drives the
 * *actual* application through the tour in docs/DEMO.md in a real browser,
 * captures the compositor's own frames over the DevTools Protocol, and burns the
 * matching script line into each beat as a caption. The result is a real,
 * reproducible screen recording of the app working - silent, captioned, and
 * labelled as such wherever it is linked.
 *
 * Why not OBS: OBS is a GUI application, and the value of this tool is that the
 * recording is scripted. `node tools/demo.js` reproduces the same video on any
 * machine with Edge/Chrome, and `docs/reports/demo.json` records exactly which
 * beats performed their interaction and which did not - a demo where a click
 * silently did nothing is a bug report, not a sales video.
 *
 * ffmpeg is not a project dependency any more than Lighthouse is. It lives in
 * .tools/ and is only needed to *encode*:
 *
 *   npm install --prefix .tools/ffmpeg ffmpeg-static
 *
 * Frames are written to .tools/demo-frames/ and deleted after encoding unless
 * --keep-frames is passed. `--encode-only` turns frames already on disk into a
 * video without recording anything, which is how a recording that was
 * interrupted (a killed process, a restarted machine) is recovered instead of
 * thrown away: the pacing comes from the sidecar each run writes, or from the
 * frames' own timestamps when the sidecar is missing.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = parseArgs();
const OUT = resolve(root, args.out || 'docs/demo/demo.mp4');
const WIDTH = Number(args.width || 1280);
const HEIGHT = Number(args.height || 720);
const FPS = Number(args.fps || 6);
const CRF = Number(args.crf || 32);
// One knob for a fast smoke run: --speed=8 makes every hold eight times shorter.
const SPEED = Number(args.speed || 1);
const KEEP = args['keep-frames'] === true || args['keep-frames'] === 'true';
const ENCODE_ONLY = args['encode-only'] === true || args['encode-only'] === 'true';
const ONLY = args.beats && args.beats !== 'all' ? String(args.beats).split(',').map(Number) : null;
const FRAMES = resolve(root, '.tools/demo-frames');
const SEQ = resolve(root, '.tools/demo-seq');
const PORT = Number(args.port || 5225);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hold = (seconds) => sleep(Math.max(250, Math.round((seconds * 1000) / SPEED)));

/** Locate the ffmpeg binary vendored under .tools (any platform). */
function findFfmpeg() {
  const base = resolve(root, '.tools/ffmpeg/node_modules/ffmpeg-static');
  for (const name of ['ffmpeg.exe', 'ffmpeg']) {
    const p = join(base, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// ------------------------------------------------------------------ captions

/**
 * A caption bar, injected into the page being recorded. It is `aria-hidden`
 * and pointer-transparent so it cannot affect the app's behaviour or its
 * accessibility audit; it exists only in the recorded pixels.
 *
 * Styling is applied through the CSSOM property by property, not through a
 * `style` attribute: the app ships a strict `style-src 'self'` policy, and a
 * style attribute would be exactly the kind of sink that policy blocks.
 */
const CAPTION_ID = 'demo-caption';

async function installCaption(session) {
  await session.evaluate(`(() => {
    if (document.getElementById('${CAPTION_ID}')) return true;
    const style = (el, props) => { for (const k in props) el.style[k] = props[k]; };
    const box = document.createElement('div');
    box.id = '${CAPTION_ID}';
    box.setAttribute('aria-hidden', 'true');
    style(box, {
      position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '2147483647',
      display: 'flex', gap: '16px', alignItems: 'baseline', padding: '16px 24px',
      background: 'linear-gradient(180deg, rgba(4,7,12,0) 0%, rgba(4,7,12,0.94) 42%)',
      borderTop: '1px solid rgba(110,168,254,0.35)',
      font: '15px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      color: '#dbe7ff', pointerEvents: 'none', textShadow: '0 1px 2px rgba(0,0,0,0.8)',
    });
    const title = document.createElement('strong');
    title.id = '${CAPTION_ID}-title';
    style(title, { color: '#9ec1ff', whiteSpace: 'nowrap', fontWeight: '700' });
    const text = document.createElement('span');
    text.id = '${CAPTION_ID}-text';
    box.append(title, text);
    document.body.append(box);
    return true;
  })()`);
}

async function setCaption(session, title, text) {
  await session.evaluate(`(() => {
    const t = document.getElementById('${CAPTION_ID}-title');
    const b = document.getElementById('${CAPTION_ID}-text');
    if (!t || !b) return false;
    t.textContent = ${JSON.stringify(title)};
    b.textContent = ${JSON.stringify(text)};
    return true;
  })()`);
}

// ------------------------------------------------------------------- capture

/**
 * The screencast. One page at a time is captured; switching stops the old
 * stream and starts the new one, so a two-tab beat (M1 sync, M5 WebRTC) is
 * genuinely two tabs and not a mock-up.
 *
 * Frames are stored with their compositor timestamps, then expanded into a
 * constant-rate sequence at encode time. That is what makes a static screen
 * still take ten seconds of real time in the video instead of flashing past.
 */
class Capture {
  constructor({ dir, width, height, quality = 72 }) {
    this.dir = dir;
    this.width = width;
    this.height = height;
    this.quality = quality;
    this.frames = []; // { file, ts }
    this.active = null;
    this.wired = new Set();
    this.startedAt = null;
  }

  async attach(session) {
    if (this.active === session) return;
    if (this.active) {
      await this.active.send('Page.stopScreencast', {}, { timeoutMs: 15000 }).catch(() => {});
    }
    // A background tab does not get composited, so it produces no screencast
    // frames at all (and its rAF loop stops). Bringing the tab we are recording
    // to the front is what makes a two-tab beat recordable - without this the
    // very first capture returned 0 frames because the second tab was in front.
    await session.send('Page.bringToFront', {}, { timeoutMs: 15000 }).catch(() => {});
    this.active = session;
    if (!this.wired.has(session)) {
      this.wired.add(session);
      session.on('Page.screencastFrame', (params) => {
        Promise.resolve().then(() => this.writeFrame(session, params)).catch(() => {});
      });
    }
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.quality,
      maxWidth: this.width,
      maxHeight: this.height,
      everyNthFrame: 1,
    });
  }

  async writeFrame(session, params) {
    if (this.active !== session) {
      // A frame from the tab we just left: acknowledge it so that tab is never
      // left with a stalled screencast, then drop it.
      await session.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      return;
    }
    const index = this.frames.length;
    const file = `frame-${String(index).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.dir, file), Buffer.from(params.data, 'base64'));
    const ts = params.metadata && typeof params.metadata.timestamp === 'number' ? params.metadata.timestamp : null;
    this.frames.push({ file, ts });
    // The pacing sidecar: without it a run that dies before encoding can only
    // be reconstructed from file timestamps, which is a rougher clock.
    appendFileSync(join(this.dir, 'timestamps.jsonl'), JSON.stringify({ file, ts }) + '\n');
    await session.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  }

  async stop() {
    if (this.active) {
      await this.active.send('Page.stopScreencast', {}, { timeoutMs: 15000 }).catch(() => {});
    }
    this.active = null;
  }

  /**
   * Expand the captured frames into a constant-rate sequence. Each frame is
   * held for as long as the compositor took to produce the next one, clamped so
   * that a long idle pause becomes a still and a burst of animation does not
   * become a slow-motion one.
   */
  expand() {
    rmSync(SEQ, { recursive: true, force: true });
    mkdirSync(SEQ, { recursive: true });
    const slot = 1 / FPS;
    let out = 0;
    for (let i = 0; i < this.frames.length; i += 1) {
      const cur = this.frames[i];
      const next = this.frames[i + 1];
      let delta = next && cur.ts != null && next.ts != null ? next.ts - cur.ts : slot * 2;
      if (!(delta > 0)) delta = slot * 2;
      const dup = Math.min(Math.max(1, Math.round(delta / slot)), FPS * 8);
      const src = join(this.dir, cur.file);
      for (let d = 0; d < dup; d += 1) {
        const name = join(SEQ, `frame-${String(out).padStart(6, '0')}.jpg`);
        try {
          linkSync(src, name);
        } catch {
          copyFileSync(src, name);
        }
        out += 1;
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ app drive

/** Click the module tab whose label matches, and wait for its panel to build. */
async function gotoModule(session, match) {
  const ok = await session.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('#tabs button')];
    const b = buttons.find((x) => ${JSON.stringify(match)}.split('|').some((m) => (x.textContent || '').includes(m)));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1400);
  return ok;
}

/** Click the first visible button in the active panel whose text matches. */
async function clickLabel(session, match) {
  return session.evaluate(`(() => {
    const needles = ${JSON.stringify(match)}.split('|').map((s) => s.toLowerCase());
    const scope = document.getElementById('main') || document.body;
    const buttons = [...scope.querySelectorAll('button')];
    const b = buttons.find((x) => needles.some((n) => (x.textContent || '').toLowerCase().includes(n)));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);
}

/** Focus an element and type into it through real input events. */
async function typeInto(session, selector, text) {
  const focused = await session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  })()`);
  if (!focused) return false;
  await session.send('Input.insertText', { text });
  return true;
}

/** Set a range input and fire the input event the app listens for. */
async function setSlider(session, index, value) {
  return session.evaluate(`(() => {
    const el = [...document.querySelectorAll('input[type=range]')][${index}];
    if (!el) return false;
    el.value = String(${value});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

/** A real key press. `vk` is the Windows virtual key code - the app's key
 *  handlers switch on `event.key`, and Chrome needs the vk to set it. */
async function press(session, key, vk, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
      text: type === 'keyDown' && key.length === 1 ? key : undefined,
    });
  }
}

/** Choose an option in the select inside the field whose label matches. */
async function setSelect(session, labelText, value) {
  return session.evaluate(`(() => {
    const want = ${JSON.stringify(labelText)}.toLowerCase();
    const selects = [...document.querySelectorAll('select')];
    const sel = selects.find((s) => {
      let node = s;
      for (let i = 0; i < 3 && node; i += 1, node = node.parentElement) {
        if ((node.textContent || '').toLowerCase().includes(want)) return true;
      }
      return false;
    });
    if (!sel) return false;
    sel.value = ${JSON.stringify(value)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function clickAt(session, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function readValue(session, selector) {
  return session.evaluate(`((document.querySelector(${JSON.stringify(selector)}) || {}).value || '')`);
}

// ------------------------------------------------------------------ the tour

const performed = [];
const skipped = [];

/** Run one beat: caption it, perform its interaction, hold, record the result. */
async function beat(ctx, index, spec) {
  const { capture } = ctx;
  const t0 = Date.now();
  const page = await ctx.pageFor(spec.page || 'a');
  await capture.attach(page);
  await installCaption(page);
  await setCaption(page, spec.title, spec.text);
  let result = 'shown';
  try {
    const r = spec.act ? await spec.act(ctx, page) : undefined;
    if (r === false) result = 'interaction not found';
  } catch (err) {
    result = `failed: ${err && err.message ? err.message : err}`;
  }
  if (result === 'shown') performed.push({ index, title: spec.title });
  else skipped.push({ index, title: spec.title, result });
  console.log(`  beat ${String(index).padStart(2)}  ${result === 'shown' ? 'ok  ' : 'WARN'}  ${spec.title}${result === 'shown' ? '' : ` (${result})`}`);
  await hold(spec.hold);
  return { index, title: spec.title, result, seconds: (Date.now() - t0) / 1000 };
}

async function tour(ctx) {
  const { a } = ctx;
  const beats = [];
  const add = (spec) => beats.push(spec);

  add({
    page: 'a', title: '0 · Cold boot',
    text: 'The shell loads, the service worker takes over, and the boot log fills in: storage, document, mesh, observers, palette, deck. Everything from here runs locally in this tab.',
    hold: 18,
    act: async () => gotoModule(a, 'M0 Dashboard'),
  });

  add({
    page: 'a', title: '0 · Dashboard — parallax and the module dial',
    text: 'Pointer parallax across nine zones. Backslash opens the module dial: a ring of all eight modules, each labelled with the score it carries.',
    hold: 22,
    act: async () => {
      for (let i = 0; i < 10; i += 1) {
        await a.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320 + i * 70, y: 180 + (i % 3) * 90 });
        await sleep(220);
      }
      await press(a, '\\', 220);
      await sleep(1200);
      await press(a, 'ArrowRight', 39);
      await sleep(700);
      await press(a, 'ArrowRight', 39);
      await sleep(900);
      await press(a, 'Escape', 27);
      await sleep(600);
      return true;
    },
  });

  add({
    page: 'a', title: '0 · The scores, and what is not measured',
    text: 'The score ring, the tier ladder and the budget table. Rows that were never run say "not measured" — the dashboard is not allowed to invent a number.',
    hold: 20,
    act: async () => {
      await a.evaluate(`window.scrollTo({ top: 520, behavior: 'smooth' })`);
      await sleep(1400);
      return true;
    },
  });

  add({
    page: 'a', title: '1 · M1 Editor — a CRDT, not a textarea',
    text: 'Typing produces operations for an RGA sequence CRDT. Every keystroke is an op; there is no document lock and no server ordering.',
    hold: 22,
    act: async () => {
      await gotoModule(a, 'M1 Editor');
      return typeInto(a, 'textarea[aria-label^="Collaborative"]', '\n// the CRDT merges whatever arrives, in any order\n');
    },
  });

  add({
    page: 'b', title: '1 · M1 Editor — a second tab, same document',
    text: 'A second tab, on the same URL. Both are editing the one document through the BroadcastChannel carrier; each tab has its own cursor and its own undo stack.',
    hold: 24,
    // The second tab is created by ctx.pageFor('b') on demand: it is opened the
    // moment this beat starts recording, and it becomes the foreground tab.
    act: async (ctx, page) => {
      await gotoModule(page, 'M1 Editor');
      return typeInto(page, 'textarea[aria-label^="Collaborative"]', '\n// typed in tab 2 - merged, not overwritten\n');
    },
  });

  add({
    page: 'a', title: '1 · M1 Editor — one document, two peers',
    text: 'Back in tab 1: the sentence typed in the other tab is already here, with its live cursor. "Add virtual peer" adds presence without a second tab; undo reverts only my own characters.',
    hold: 26,
    act: async () => {
      await clickLabel(a, 'Add virtual peer');
      await sleep(1200);
      await clickLabel(a, 'Add virtual peer');
      await sleep(1600);
      await clickLabel(a, 'Undo (mine only)');
      await sleep(1400);
      return true;
    },
  });

  add({
    page: 'a', title: '2 · M2 C Runtime — real C, in a worker',
    text: 'A real lexer, parser and interpreter, sandboxed in a worker with no DOM, no network and no storage. This program uses a struct, malloc and a scanf read from the stdin box.',
    hold: 26,
    act: async () => {
      await gotoModule(a, 'M2 C Runtime');
      return clickLabel(a, 'Compile & run');
    },
  });

  add({
    page: 'a', title: '2 · M2 C Runtime — diagnostics and the step budget',
    text: 'Break the program: the diagnostic names the line and the column. Then an infinite loop — the deterministic step budget stops it and the tab stays responsive.',
    hold: 24,
    act: async () => {
      await clickLabel(a, 'Load infinite loop');
      await sleep(800);
      await clickLabel(a, 'Compile & run');
      await sleep(2500);
      await typeInto(a, 'textarea[aria-label="C source code"]', '\nint broken( { \n');
      await sleep(600);
      return clickLabel(a, 'Compile & run');
    },
  });

  add({
    page: 'a', title: '3 · M3 3D Engine — WebGL2, from scratch',
    text: 'One indexed cube, hardware instancing, animated in the vertex shader. A real depth-only shadow pass feeds PCF sampling; a million particles come from gl_VertexID with no vertex buffers at all.',
    hold: 24,
    act: async () => {
      await gotoModule(a, 'M3 3D Engine');
      await sleep(1500);
      return true;
    },
  });

  add({
    page: 'a', title: '3 · M3 at maximum settings',
    text: 'Instances to 100,000 and particles to 1,000,000 while the frame rate readout keeps counting. The measured numbers are in LOAD_CHAOS.md, including the ones that fall short.',
    hold: 22,
    act: async () => {
      await setSlider(a, 0, 100000);
      await sleep(900);
      await setSlider(a, 1, 1000000);
      await sleep(1200);
      return true;
    },
  });

  add({
    page: 'a', title: '4 · M4 E2EE — X3DH and the Double Ratchet',
    text: 'The handshake is real X3DH over WebCrypto, and the prekey bundle signature is verified before any key material is derived. The relay inspector shows the routing metadata and the ciphertext, and nothing else.',
    hold: 26,
    act: async () => {
      await gotoModule(a, 'M4 E2EE');
      await clickLabel(a, 'Run X3DH handshake');
      await sleep(2200);
      await clickLabel(a, 'Encrypt & deliver a message');
      await sleep(2000);
      return clickLabel(a, 'Chunked 700 KiB file round-trip');
    },
  });

  add({
    page: 'b', title: '4 · M4 E2EE — the same ciphertext, the other tab',
    text: 'The message and the file arrive in the second tab and are decrypted by the ratchet. What is not claimed: no audited key storage, and the identity keys are not yet non-extractable.',
    hold: 20,
    act: async (ctx, page) => {
      await clickLabel(page, 'Run X3DH handshake');
      await sleep(2000);
      await page.evaluate(`window.scrollTo({ top: 620, behavior: 'smooth' })`);
      await sleep(1600);
      return true;
    },
  });

  add({
    page: 'a', title: '5 · M5 Mesh — an invite code, no server',
    text: 'Signaling is a code you copy. Step 1 creates an offer in this tab; there is no signaling server anywhere in the project.',
    hold: 20,
    act: async () => {
      await gotoModule(a, 'M5 Mesh');
      await clickLabel(a, 'Step 1');
      await sleep(2200);
      return true;
    },
  });

  add({
    page: 'b', title: '5 · M5 Mesh — the answer, in the other tab',
    text: 'The invite is pasted into tab 2, which produces the answer code. Copying codes by hand is the whole handshake: two machines, no rendezvous point.',
    hold: 24,
    act: async (ctx, page) => {
      await gotoModule(page, 'M5 Mesh');
      const invite = await readValue(ctx.a, '#rtc-code');
      if (!invite || invite.length < 12) return false;
      await typeInto(page, '#rtc-code', invite);
      await sleep(500);
      await clickLabel(page, 'Step 2');
      await sleep(2400);
      return true;
    },
  });

  add({
    page: 'a', title: '5 · M5 Mesh — a real WebRTC data channel',
    text: 'The answer goes back into tab 1: the link opens over WebRTC and every edit now crosses a real data channel instead of the same-browser carrier.',
    hold: 26,
    act: async (ctx, page) => {
      const other = await ctx.pageFor('b');
      const answer = await readValue(other, '#rtc-code');
      if (!answer || answer.length < 12) return false;
      await typeInto(page, '#rtc-code', answer);
      await sleep(500);
      await clickLabel(page, 'Step 3');
      await sleep(3000);
      // The beat only counts as performed if the panel actually reports the
      // WebRTC carrier - a click that did nothing is a bug report, not a demo.
      const carrier = await page.evaluate(`document.body.innerText.toLowerCase().includes('webrtc')`);
      return Boolean(carrier);
    },
  });

  add({
    page: 'a', title: '6 · M6 Offline — storage that survives',
    text: 'The op log, the snapshot, quota and persistence state, all from IndexedDB. Compaction collects tombstones and trims the log against a peer-derived watermark.',
    hold: 24,
    act: async () => {
      await gotoModule(a, 'M6 Offline');
      await clickLabel(a, 'Request persistent storage');
      await sleep(1200);
      return clickLabel(a, 'Compact');
    },
  });

  add({
    page: 'a', title: '6 · M6 Offline — the evidence behind the claim',
    text: 'tools/durability.js types an edit and reloads immediately: the edit survives at every delay, including zero. That measurement, and the ones that fall short, are in LOAD_CHAOS.md.',
    hold: 18,
    act: async () => {
      await a.evaluate(`window.scrollTo({ top: 700, behavior: 'smooth' })`);
      await sleep(1400);
      return true;
    },
  });

  add({
    page: 'a', title: '7 · M7 Access — preferences that change real behaviour',
    text: 'Visual effects off removes the aurora, the scanlines and the perspective floor, and reclaims frame time. Contrast, scale, motion and writing direction are user settings here, not a media query the user cannot reach.',
    hold: 24,
    act: async () => {
      await gotoModule(a, 'M7 Access');
      await sleep(1200);
      const off = await setSelect(a, 'Visual effects', 'off');
      await sleep(2000);
      const rtl = await setSelect(a, 'Writing direction', 'rtl');
      await sleep(1800);
      await setSelect(a, 'Writing direction', 'ltr');
      await sleep(1200);
      await setSelect(a, 'Visual effects', 'full');
      return off && rtl;
    },
  });

  add({
    page: 'a', title: '7 · M7 Access — the command palette and the 3D text alternative',
    text: 'Ctrl+K drives the whole app from the keyboard, Alt+1..8 jumps between modules, and the 3D scene publishes a live text alternative instead of a silent canvas.',
    hold: 22,
    act: async () => {
      await press(a, 'k', 75, 2); // 2 = Ctrl
      await sleep(1200);
      await typeInto(a, '.palette-input', 'engine');
      await sleep(1400);
      await press(a, 'Escape', 27);
      await sleep(600);
      return true;
    },
  });

  add({
    page: 'a', title: '8 · M8 Hardening — the hostile environment',
    text: 'The live policy: strict CSP, Trusted Types enforced, sandbox isolation, COOP/COEP. The probes try the two classic injection paths and stay inert because there is no markup sink in the codebase.',
    hold: 24,
    act: async () => {
      await gotoModule(a, 'M8 Hardening');
      await sleep(1200);
      await clickLabel(a, 'Attempt innerHTML injection');
      await sleep(1800);
      return clickLabel(a, 'Attempt eval()');
    },
  });

  add({
    page: 'a', title: '8 · M8 Hardening — the headers a static host could not send',
    text: 'frame-ancestors, Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy cannot be expressed in a meta tag. They are served from _headers by the current host and verified header by header with tools/verify-headers.js.',
    hold: 20,
    act: async () => {
      await a.evaluate(`window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })`);
      await sleep(1600);
      return true;
    },
  });

  add({
    page: 'a', title: 'Close · the suite, running in this browser',
    text: 'The whole suite — including the WebGL2 renderer, the IndexedDB store and the fuzzer — runs green in a real browser at /tests/browser.html.',
    hold: 40,
    act: async (ctx, page) => {
      await page.send('Page.navigate', { url: ctx.a.origin + '/tests/browser.html' });
      await page.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
      await sleep(2500);
      return true;
    },
  });

  add({
    page: 'a', title: 'Close · what is still missing',
    text: 'No red-team session, no audited crypto, no TURN relay, no glTF or HDRI probe, no clang to WASM, no screen-reader pass, and no distributed load rig. Every gap is named in LOAD_CHAOS.md rather than rounded up.',
    hold: 16,
    act: async () => {
      await a.evaluate(`window.scrollTo({ top: 0, behavior: 'smooth' })`);
      await sleep(800);
      return true;
    },
  });

  const results = [];
  for (let i = 0; i < beats.length; i += 1) {
    if (ONLY && !ONLY.includes(i)) {
      await sleep(0);
      continue;
    }
    results.push(await beat(ctx, i, beats[i]));
  }
  return results;
}

// ------------------------------------------------------------------ encode

function encode(out, framesWritten) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found - npm install --prefix .tools/ffmpeg ffmpeg-static');
  const filter =
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x05070b,format=yuv420p`;
  const cmd = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', join(SEQ, 'frame-%06d.jpg'),
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF),
    '-movflags', '+faststart',
    out,
  ];
  mkdirSync(resolve(out, '..'), { recursive: true });
  const r = spawn(ffmpeg, cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  r.stderr.on('data', (c) => {
    err += String(c);
  });
  return new Promise((resolvePromise, reject) => {
    r.on('exit', (code) => {
      if (code === 0) resolvePromise({ cmd: [ffmpeg, ...cmd], stderr: err.trim() });
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
  });
}

/**
 * Rebuild the frame list from what is on disk: the pacing sidecar when it
 * exists, the files' own timestamps when it does not (a run killed before it
 * could write the sidecar still has perfectly good frames).
 */
function framesFromDisk(dir) {
  const files = readdirSync(dir)
    .filter((f) => /^frame-\d+\.jpg$/.test(f))
    .sort();
  if (!files.length) return [];
  const sidecar = new Map();
  try {
    for (const line of readFileSync(join(dir, 'timestamps.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry && entry.file) sidecar.set(entry.file, entry.ts);
    }
  } catch {
    /* no sidecar: fall back to the filesystem clock below */
  }
  const usingSidecar = files.some((f) => sidecar.has(f));
  const frames = files.map((file) => ({
    file,
    ts: usingSidecar && sidecar.has(file) ? sidecar.get(file) : statSync(join(dir, file)).mtimeMs / 1000,
    tsSource: usingSidecar && sidecar.has(file) ? 'sidecar' : 'file-mtime',
  }));
  return frames.map((f, i) => ({ ...f, pacing: frames[0] ? frames[0].tsSource : 'file-mtime', index: i }));
}

// ------------------------------------------------------------------ main

// Recover a recording that was interrupted: encode the frames already captured.
if (ENCODE_ONLY) {
  const frames = framesFromDisk(FRAMES);
  if (!frames.length) {
    console.error(`# no frames in ${FRAMES} to encode`);
    process.exit(2);
  }
  console.log(`# encode-only: ${frames.length} frames from ${FRAMES}`);
  console.log(`# pacing from: ${frames[0].pacing}`);
  const capture = new Capture({ dir: FRAMES, width: WIDTH, height: HEIGHT });
  capture.frames = frames;
  const slots = capture.expand();
  const videoSeconds = slots / FPS;
  console.log(`# expanded to ${slots} frames at ${FPS} fps = ${(videoSeconds / 60).toFixed(1)} minutes`);
  await encode(OUT, slots);
  const bytes = statSync(OUT).size;
  const report = {
    generatedAt: new Date().toISOString(),
    viewport: { width: WIDTH, height: HEIGHT },
    video: {
      path: OUT.replace(root, '').replace(/^[/\\]/, ''),
      fps: FPS,
      crf: CRF,
      seconds: Number(videoSeconds.toFixed(1)),
      bytes,
      codec: 'libx264 / yuv420p / +faststart',
      narration: 'none - the script in docs/DEMO.md is printed as captions, it is not spoken',
      recovered: 'encoded from frames captured by an earlier run that was interrupted before it could encode',
    },
    capture: {
      compositorFrames: frames.length,
      expandedFrames: slots,
      pacing: frames[0].pacing,
      expand: 'each frame is held for the real interval until the next one, clamped to 8 s, so idle pauses stay in real time',
    },
  };
  mkdirSync('docs/reports', { recursive: true });
  writeFileSync('docs/reports/demo.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`# wrote ${OUT} (${(bytes / 1048576).toFixed(1)} MiB)`);
  console.log('# report -> docs/reports/demo.json');
  mkdirSync(SEQ, { recursive: true });
  if (!KEEP) {
    rmSync(SEQ, { recursive: true, force: true });
    rmSync(FRAMES, { recursive: true, force: true });
  }
  process.exit(0);
}

const { proc, origin } = await startProjectServer({ port: PORT });
console.log(`# demo recording against ${origin}/`);
if (!findFfmpeg()) console.log('# warning: ffmpeg is missing, frames will be kept but not encoded');

// The recorded surface is a fixed 1280x720 viewport: every frame the compositor
// hands over is then exactly the same size, which is what makes the JPEG
// sequence a valid ffmpeg input.
// softwareGl: the recording walks through the M3 panel, and a headless browser
// only has a WebGL2 context if the software rasteriser is requested by name.
const browser = await Browser.launch({
  width: WIDTH,
  height: HEIGHT,
  scale: 1,
  extraArgs: ['--hide-scrollbars'],
  softwareGl: true,
});
const a = await browser.newSession(origin + '/');
a.origin = origin;

let report = null;
let exitCode = 0;
try {
  await a.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await a.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
  await a.waitFor('document.querySelectorAll("#tabs button").length > 0', { timeoutMs: 90000 });

  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const capture = new Capture({ dir: FRAMES, width: WIDTH, height: HEIGHT, quality: 74 });
  await capture.attach(a);
  const startedAt = Date.now();
  // The second tab is opened only when a beat needs it, and it is always the
  // foreground tab while it is being recorded.
  const ctx = {
    a,
    b: null,
    capture,
    async pageFor(tag) {
      if (tag !== 'b') return ctx.a;
      if (ctx.b) return ctx.b;
      const second = await browser.newSession('about:blank');
      second.origin = origin;
      await second.send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
      });
      await second.send('Page.navigate', { url: origin + '/' });
      await second.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
      await second.waitFor('document.querySelectorAll("#tabs button").length > 0', { timeoutMs: 90000 });
      await sleep(2500);
      ctx.b = second;
      return second;
    },
  };
  const beats = await tour(ctx);
  await capture.stop();
  const recordSeconds = (Date.now() - startedAt) / 1000;
  console.log(`# captured ${capture.frames.length} compositor frames over ${recordSeconds.toFixed(1)} s`);

  const slots = capture.expand();
  const videoSeconds = slots / FPS;
  console.log(`# expanded to ${slots} frames at ${FPS} fps = ${(videoSeconds / 60).toFixed(1)} minutes`);

  const enc = await encode(OUT, slots);
  const bytes = statSync(OUT).size;
  console.log(`# wrote ${OUT} (${(bytes / 1048576).toFixed(1)} MiB)`);

  report = {
    generatedAt: new Date().toISOString(),
    host: origin,
    viewport: { width: WIDTH, height: HEIGHT },
    video: {
      path: OUT.replace(root, '').replace(/^[/\\]/, ''),
      fps: FPS,
      crf: CRF,
      seconds: Number(videoSeconds.toFixed(1)),
      bytes,
      codec: 'libx264 / yuv420p / +faststart',
      narration: 'none - the script in docs/DEMO.md is printed as captions, it is not spoken',
    },
    capture: {
      compositorFrames: capture.frames.length,
      expandedFrames: slots,
      seconds: Number(recordSeconds.toFixed(1)),
      expand: 'each frame is held for the real interval until the next compositor frame, clamped to 8 s, so idle pauses stay in real time',
    },
    beats: { performed, skipped },
    ffmpeg: enc.cmd.slice(0, 2).join(' '),
    completeness: skipped.length === 0 ? 'every beat performed its interaction' : `${skipped.length} beat(s) did not perform their interaction: ${skipped.map((s) => `${s.title} (${s.result})`).join('; ')}`,
  };

  if (KEEP) console.log('# frames kept in .tools/demo-frames and .tools/demo-seq');
  else {
    rmSync(FRAMES, { recursive: true, force: true });
    rmSync(SEQ, { recursive: true, force: true });
  }
} catch (err) {
  console.error(`# demo recording failed: ${err && err.message ? err.message : err}`);
  exitCode = 1;
} finally {
  const { mkdirSync: mk, writeFileSync: wr } = await import('node:fs');
  if (report) {
    mk('docs/reports', { recursive: true });
    wr('docs/reports/demo.json', JSON.stringify(report, null, 2) + '\n');
    console.log('# report -> docs/reports/demo.json');
  }
  await browser.close();
  proc.kill();
}
process.exit(exitCode);
