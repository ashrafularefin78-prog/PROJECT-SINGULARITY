# M7 accessibility validation

Status: **NVDA 2026.2 pass complete** (Windows Edge, 2026-10-22). VoiceOver,
TalkBack and JAWS are still pending.

The previous evidence for M7 was the axe-core run, the accessibility-tree audit
and the 12-rule in-app contract - all real, but none of them is a person
listening to a screen reader. This pass starts NVDA with debug logging, drives
the live app through CDP, and decodes NVDA's own `Speaking [...]` lines.
Artifact: [docs/reports/nvda-session.md](reports/nvda-session.md) and
[`nvda-session.json`](reports/nvda-session.json) (17/17 steps, 0 failures).

## Score

- **Structural maximum: 83/100** - unchanged.
- **Evidence-backed score: 66/100** - up from 55; the reviewer's current mark is
  the ceiling until the restored NVDA artifact is re-verified.
- The remaining 17 points are the untested platforms (VoiceOver, TalkBack,
  JAWS), the deeper M2/M4/M5/M6 flows that this pass only reached at panel
  level, and Bangla/Arabic pronunciation (the language tags are verified; the
  speech voices are not installed on this machine).

## What the pass found and fixed

1. **Alt+1..8 left focus on `<body>`; NVDA announced nothing.** The panel
   heading now has `tabindex="-1"`, and `renderPanel` focuses the new panel's
   `.mod-title` when the switch did not come from a tab or from a control in
   the old panel.
2. **The first restore version put focus back on `#main`.** `<main>` has an id,
   so a generic "restore the old id" branch restored the landmark instead of
   the heading. The restore branch now only handles controls that lived inside
   the old panel. The first run of the NVDA harness caught this regression;
   the committed run is after the fix.
3. **The M3 canvas had no accessible name and its text alternative was not
   associated.** It now has `role="img"`, a live `aria-label` built from the
   renderer's scene summary, `aria-describedby="scene-alt"` and
   `aria-keyshortcuts` for the orbit keys. NVDA reads the summary, camera,
   object counts and key list as one graphic.

The same restore rule covers tab clicks, arrow-key selection and preference
re-renders: the tab strip and panel are rebuilt on every switch, so the control
that triggered the render is re-focused by id.

## Per-view result

| View | NVDA said | What was missing | Fix |
|---|---|---|---|
| M0 Dashboard | "Skip to main content" on first Tab; Enter: "main landmark, M0 Dashboard, property page, … Project Singularity, heading level 1" | Nothing at boot; initial focus is `<body>` as intended | None |
| M1 Editor | "1. M1 Editor, property page, Real-time collaborative editor, heading level 1"; editor "Collaborative C document, synchronised with every peer, edit, multi line" | Alt+1 left focus on body and said nothing | Focus the panel h1 |
| M2 C Runtime | "2. M2 C Runtime, property page, In-browser C compiler and runtime, heading level 1" | Same focus bug | Focus the panel h1 |
| M3 3D Engine | Heading, then "3D scene: 20,000 instanced cubes … graphic … ArrowLeft ArrowRight ArrowUp ArrowDown + dash" | Canvas was unnamed; `#scene-alt` was not associated | `role="img"`, live label, `aria-describedby`, key shortcuts |
| M4 E2EE | "4. M4 E2EE, property page, End-to-end encrypted layer, heading level 1" | Same focus bug | Focus the panel h1 |
| M5 Mesh | "5. M5 Mesh, property page, Peer mesh: WebRTC data channels + ciphertext-only relay, heading level 1" | Same focus bug | Focus the panel h1 |
| M6 Offline | "6. M6 Offline, property page, Offline-first sync and storage, heading level 1" | Same focus bug | Focus the panel h1 |
| M7 Access | Heading; "CONTENT LANGUAGE, combo box, বাংলা (Bangla), collapsed"; "WRITING DIRECTION, combo box, Right-to-left (العربية), collapsed" | Preference re-render lost focus | Restore the same-id select |
| M8 Hardening | "8. M8 Hardening, property page, Hostile-environment hardening, heading level 1" | Same focus bug | Focus the panel h1 |

## Bangla, Arabic and RTL

- Setting **Content language** to Bangla set `document.documentElement.lang =
  "bn"`; focusing the editor after inserting `বাংলা ভাষা পরীক্ষা` produced
  `LangChangeCommand ('bn')` and NVDA read the text. NVDA also said "Bangla
  (not supported)" because this machine has no Bangla OneCore voice.
- Arabic behaved the same way: `lang="ar"`, `LangChangeCommand ('ar')`, and
  `اختبار اللغة العربية` read back from the editor. "Arabic (not supported)"
  is the missing voice, not a missing language tag.
- Setting **Writing direction** to RTL set `document.documentElement.dir =
  "rtl"` and NVDA announced the "Right-to-left (العربية)" option. Code and
  terminal surfaces intentionally stay LTR.

## Reproduce

```powershell
node tools/nvda-session.js --nvda="C:\path\to\nvda_noUIAccess.exe"
node tools/nvda-session.js --self-test
```

The raw NVDA log is a desktop-wide debug log and is not committed. Use
`--keep-log` to keep it for a review; the JSON artifact contains the decoded
speech, language switches, focus state and versions.

## Still open

- VoiceOver (Safari/macOS), TalkBack (Android) and JAWS.
- M2, M4, M5 and M6 forms/dialogs/error paths were reached, not driven.
- The M7 "Run the audit" button and the live audit table were not driven by
  NVDA; the contract itself is covered by `tests/a11y.test.js`.
- Bangla/Arabic pronunciation needs the corresponding OS voices.
- The tablist arrow path is not timed in the NVDA artifact; the eight panels
  were driven with Alt+1..8. Tab click, arrow selection and preference restore
  are covered by the DOM focus test used during the fix, not by this artifact.
- No audio/video recording; the evidence is NVDA's speech queue.
