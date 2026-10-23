# NVDA session — 2026-10-22

Real screen-reader run, not an accessibility-tree inspection. NVDA was started
with debug logging, a windowed Edge session was driven over the DevTools
Protocol, and the transcript below is decoded from NVDA's own
`Speaking [...]` log lines.

Artifact: [`nvda-session.json`](nvda-session.json) (17 steps, 0 failures). This
JSON is evidence, not a synced document: `tools/check-docs.js` verifies the
recorded hash and fails the build if the file changes.
SHA-256: `a01f247022b4210c4ffb870d132121d853e40fc8ffe9f86110bfac0bebaf73e0`.

| | |
|---|---|
| Screen reader | NVDA **2026.2** (64-bit, portable copy, no add-ons) |
| Browser | Microsoft Edge **156.0.4314.36** (Chromium), windowed, `--force-renderer-accessibility` |
| Host | Windows 10.0.26300, 1280 × 900, 100% scale |
| Page | local project server, `http://127.0.0.1:5215/` (the same `_headers` policy as the deploy) |
| Evidence | 17/17 steps passed; every panel step checks both NVDA speech and the focused DOM element |

Reproduce:

```powershell
node tools/nvda-session.js --nvda="C:\path\to\nvda_noUIAccess.exe"
node tools/nvda-session.js --self-test   # parser only, no NVDA
```

The raw NVDA log is a desktop debug log and is deliberately not committed; the
JSON keeps the decoded speech, language switches, DOM focus, browser and NVDA
versions. `--keep-log` prints the path when a reviewer wants the raw file.

## What the session found

Two real defects, both fixed in `src/app.js`, plus one focus bug found while
building the harness:

1. **Alt+1..8 left focus on `<body>`, and NVDA announced nothing.** The panel
   heading is now programmatically focusable (`tabindex="-1"`), and
   `renderPanel` focuses the new panel's `.mod-title` when the jump did not come
   from a tab or a control inside the old panel.
2. **Restoring focus by `id` put focus back on `#main`.** The landmark has an
   id, so the first version of the fix restored the `<main>` element instead of
   the heading and NVDA stayed silent. The restore branch now only handles a
   control that lived inside the old panel; the first run of this harness
   caught that regression.
3. **The M3 canvas had no accessible name and its text alternative was not
   associated with it.** It now has `role="img"`, a live `aria-label` built
   from the renderer's scene summary, `aria-describedby="scene-alt"` pointing
   at the visible description, and `aria-keyshortcuts` for the orbit keys.

The same per-panel focus rule also fixes the tab click and preference-change
paths: the tab strip is rebuilt on every switch, so the control that triggered
the render no longer exists afterwards. A tab is re-focused by id; a preference
select is restored by id; a programmatic jump lands on the heading.

## Per-view result

Each row is a separate step in the artifact. "Announced" is a literal excerpt
from the decoded log.

| View | NVDA announced | Missing before the fix | Status |
|---|---|---|---|
| **M0 Dashboard** | First Tab: "Skip to main content same page link". Enter: "main landmark, M0 Dashboard, property page, THE IMPOSSIBLE WEBSITE CHALLENGE, Project Singularity, heading level 1" plus the page lede, score graphics and constellation description. | Nothing at boot; initial focus was `<body>` as intended. The window title is set (`M0 Dashboard · Project Singularity`) but the first Tab, not the window, carried the first utterance. | Pass |
| **M1 Editor** | "1. M1 Editor, property page, Real-time collaborative editor, heading level 1". Editor: "Collaborative C document, synchronised with every peer, edit, multi line". | Focus stayed on `<body>` after Alt+1; no announcement. | Pass |
| **M2 C Runtime** | "2. M2 C Runtime, property page, In-browser C compiler and runtime, heading level 1". | Same focus bug. | Pass (heading only; the C form flow was not exercised) |
| **M3 3D Engine** | Heading, then the canvas: "Scene, region, 3D scene: 20,000 instanced cubes…, graphic, 3D scene: … Orbit camera…, Instanced cubes: 20,000…, ArrowLeft ArrowRight ArrowUp ArrowDown + dash". | Canvas had no role or name, and `#scene-alt` was not referenced by `aria-describedby`. A screen reader heard an unnamed graphic. | Pass |
| **M4 E2EE** | "4. M4 E2EE, property page, End-to-end encrypted layer, heading level 1". | Same focus bug. | Pass (heading only; the passphrase/key flows were not exercised) |
| **M5 Mesh** | "5. M5 Mesh, property page, Peer mesh: WebRTC data channels + ciphertext-only relay, heading level 1". | Same focus bug. | Pass (heading only; the invite/join flows were not exercised) |
| **M6 Offline** | "6. M6 Offline, property page, Offline-first sync and storage, heading level 1". | Same focus bug. | Pass (heading only; storage controls were not exercised) |
| **M7 Access** | Heading; "CONTENT LANGUAGE, combo box, বাংলা (Bangla), collapsed"; "WRITING DIRECTION, combo box, Right-to-left (العربية), collapsed". | Preference changes re-rendered the panel and lost focus. All seven selects now restore by id. | Pass |
| **M8 Hardening** | "8. M8 Hardening, property page, Hostile-environment hardening, heading level 1". | Same focus bug. | Pass (heading only; the header table was not read line by line) |

## Editor text in Bangla and Arabic

After setting **Content language** to Bangla, the editor was focused and the
text replaced with `বাংলা ভাষা পরীক্ষা`. NVDA announced:

> "1. M1 Editor, property page, Bangla (not supported), Real-time collaborative
> editor, heading level 1 … Collaborative C document … edit, multi line,
> বাংলা ভাষা পরীক্ষা"

After setting Arabic, the same flow with `اختبار اللغة العربية` produced:

> "1. M1 Editor, property page, Arabic (not supported) … edit, multi line,
> اختبار اللغة العربية"

The "(not supported)" is NVDA's OneCore voice availability, not the page: the
log carries `LangChangeCommand ('bn')` and `LangChangeCommand ('ar')` at the
text, and `document.documentElement.lang` is `bn` / `ar` in the artifact. The
app sets the language; the operating system needs a Bangla/Arabic voice to
pronounce it. No such voice is installed on this machine, so pronunciation
itself is not claimed.

Setting **Writing direction** to RTL produced
`document.documentElement.dir === "rtl"` and NVDA announced the
"Right-to-left (العربية)" option. Code and terminal surfaces stay LTR, as the
panel documents.

## Limits, stated plainly

- **Windows NVDA only.** VoiceOver (Safari/macOS), TalkBack (Android) and JAWS
  were not run. The score is 66/100, not the 83 structural maximum.
- **M2, M4, M5 and M6 were reached and announced, not exhaustively driven.**
  Their forms, dialogs and error paths still need a screen-reader pass.
- **The M7 audit button and the live audit table were not driven.** The audit
  contract is covered by `tests/a11y.test.js`, not by this session.
- **No audio or video recording.** The evidence is NVDA's speech queue, which
  is the same text the synthesizer receives; it is not an acoustic recording.
- **The tablist arrow path is not in this artifact.** The eight panels were
  driven with their documented Alt+1..8 shortcuts. The focus-restoration code
  also handles tab clicks, arrow-key selection and preference re-renders, but
  only the Alt path is timed and asserted here.
- **Bangla/Arabic pronunciation is not verified** because the required voices
  are not installed; language tagging and reading order are verified.
