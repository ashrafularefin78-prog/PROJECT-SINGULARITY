# Demo tour script

The brief asks for a 10-minute demo video showing every module working together
in one session. **That video was not recorded** — see the note at the bottom.
This is the script a narrator would follow, and it doubles as a manual
acceptance test: every step names what you should see, so anyone can run the
tour and check the claims in the README in about ten minutes.

Setup, once:

```bash
python3 tools/serve.py 5173        # -> http://127.0.0.1:5173/
```

Keep a second browser tab open on the same URL for the collaboration steps.

## 0. Dashboard — the honest scores (1 min)

1. Open the app. Watch the boot sweep cross the deck frame and the boot log fill
   in: storage, document, mesh, observers, palette, deck, "ready".
2. Move the pointer around: the corner brackets, the radar ring and the aurora
   shift against each other in nine parallax zones.
3. Point at the deck strip under the tabs: the waveform is plotting real activity
   (frame rate while M3 runs, document ops/s otherwise) and the ticker is reading
   live numbers.
4. Press the backslash key: the **module dial** opens with all eight modules on a
   ring, each labelled with the score it is actually carrying. Arrow keys turn
   it, digits jump straight to a module, Enter opens it, Escape closes.
5. Point at the score ring: **637 / 1000**, points band **Gold**.
6. Point at the tier ladder: Bronze says *requirement: met*, Silver says *not met
   (3 of 4 modules)*. Say out loud that the leading column is the brief's points
   band and the ladder grades the *requirements*, which is why the two disagree.
7. Point at the budget table: payload **met** (78 KiB gzip of JavaScript plus
   15 KiB of CSS, against a 170 KB ceiling), frame rate **met**, everything
   unmeasured labelled *not measured*.

## 1. M1 Editor — the CRDT (1.5 min)

1. Open **1. M1 Editor**. Type a sentence.
2. In the second tab (same module), type a different sentence.
3. Show both tabs: the same text, merged, with live cursors and the peer list.
4. Press **Go offline**, type in tab 1, then go online: nothing is lost.
5. Press **Add virtual peer** twice: presence and cursors converge without a
   second tab.
6. Press **Undo (mine only)**: only this tab's characters revert.

## 2. M2 C Runtime — real C, sandboxed (1.5 min)

1. Open **2. M2 C Runtime** and press **Run** on the default sample: `fib`,
   a struct, a `malloc` linked list, a `switch` on a grade, `scanf` reading two
   integers from the stdin box, then stdin echoed.
2. Break it on purpose: delete a `}` and run. Show the lexer/parser diagnostic
   with **line and column**.
3. Load the infinite-loop sample and run it: the step budget stops it, the tab
   stays responsive.
4. Point at the devtools network tab: no request leaves the page — it runs in a
   worker with no DOM, storage, crypto or network.

## 3. M3 3D Engine — WebGL2 from scratch (1 min)

1. Open **3. M3 3D Engine**: cube 3D scene, 4 draw calls, FPS readout, PCF
   shadows, particles.
2. Drag to orbit; then push **instances to 100,000** and **particles to
   1,000,000** and read the FPS (58 on the machine measured for
   [LOAD_CHAOS.md](LOAD_CHAOS.md)).
3. Arrow keys orbit when the canvas has focus (that is the M7 keyboard model
   reaching into a canvas that is otherwise invisible to assistive tech).

## 4. M4 E2EE — X3DH and the Double Ratchet (1.5 min)

1. Open **4. M4 E2EE**. Show the safety number (60 digits) in both tabs — the
   numbers match, which is how two humans detect a substituted key.
2. Encrypt a message and read the **relay inspector**: it lists routing metadata
   plus ciphertext, and nothing else.
3. Send a message in tab 1 and read it in tab 2.
4. Send a 700 KiB file: it streams as authenticated chunks.
5. Say what is *not* there: no audited key storage, no local encryption at rest.

## 5. M5 Mesh — two machines, no server (1 min)

1. Open **5. M5 Mesh**. Press **Create invite code** in tab 1.
2. Paste that code into the same panel in the second tab, copy the **answer**
   code back, paste it into tab 1.
3. The peers list shows the link opening over **WebRTC**, and the badges in M1
   switch to the `webrtc` carrier. Every edit now crosses a real data channel.
4. If both ends are behind symmetric NAT, note the honest limitation: no bundled
   TURN relay.

## 6. M6 Offline — storage that survives (1 min)

1. Open **6. M6 Offline**. Show the op log, the snapshot, quota usage and
   persistence state.
2. Press **Compact**: it reports the collected tombstones, the trimmed ops and
   the watermark that allowed it.
3. Stop the server (`Ctrl+C`), reload the page: the shell still loads from the
   service worker and the document is intact.
4. Start the server again and reload under a subpath to show the scope-relative
   paths: `python3 tools/serve.py 5174 --prefix /PROJECT-SINGULARITY`.

## 7. M7 Accessibility — preferences that change real behaviour (1 min)

1. Open **7. M7 Access**. Turn **Visual effects** off: the aurora, scanlines and
   perspective floor disappear, nothing else changes.
2. Change contrast, scale, motion and direction (RTL) and show the layout respond.
3. Open the text alternative tree for the 3D scene.
4. Press **Ctrl/Cmd + K** and drive the app from the command palette; show
   **Alt + 1…8** jumping between modules.

## 8. M8 Hardening — the hostile environment (1 min)

1. Open **8. M8 Hardening**. Show the live policy state: CSP, Trusted Types
   enabled, sandbox isolation, COOP/COEP.
2. Run the **hostile input probe**: `<img onerror>` and `<script>` stay inert
   text because there is no markup sink anywhere in the codebase.
3. Show the STRIDE table and the security test report
   ([SECURITY_REPORT.md](SECURITY_REPORT.md)), including the finding that the
   handshake used to skip bundle verification.

## Close (30 s)

Open **/tests/browser.html** and let the suite run: **120 tests, 9 suites, all
green**, including the fuzzer. Then name the gaps: no red-team session, no
audited crypto, no TURN, no glTF/IBL, no clang→WASM, no screen-reader pass, and
no distributed load or chaos rig.

## Why there is no video file here

Producing the brief's 10-minute narrated video needs a human narrator and a
recording setup; what exists in this repository is the script above, the
automated suite, and the measurements in [LOAD_CHAOS.md](LOAD_CHAOS.md). Calling
a silent screen capture a "10-minute demo video" would be exactly the kind of
claim the rest of this project avoids.
