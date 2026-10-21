# M7 accessibility validation runbook

Goal: close the honest 55/100 ceiling in `src/app.js` (case-study
evidence for M7) by recording a real NVDA + VoiceOver pass over the
editor, tablist and theme controls, then fixing whatever each finds.

## Setup

- NVDA 2025.x on Windows Edge (latest), speech rate 40%.
- VoiceOver on macOS Safari (latest), verbosity default.
- A physical keyboard, no mouse/trackpad for the first pass.
- Capture: screen + audio, trimmed to the flows below. File the recording
  alongside `docs/reports/` and note the browser/SR versions used.

## Flows to walk (repeat for both NVDA and VoiceOver)

1. **Shell boot.** Load the site; confirm the page title is announced, the
   skip link lands on the tablist, and the active module is announced
   (`aria-current` / selected tab).
2. **Tablist.** Roaming with arrow keys between the eight modules; Enter
   activates; the panel title + description are announced; back/forward
   buttons move history and announce the new panel.
3. **Editor (M1).** Focus the editor; type a sentence; confirm per-keystroke
   announcements don't spam; undo/redo announced once; the second tab that
   is kept open announces the remote insert via the live region.
4. **Theme / preferences (M7).** Open the command palette (`Ctrl/Cmd+K`),
   switch dark/light, reduced motion, high contrast, scale and RTL; each
   change must be announced and persist across reload. Verify no dark flash
   on a light-preferred reload.
5. **3D scene (M3).** Confirm the canvas has an `img` role with a live
   `aria-label` built from the same model; the text alternative is readable
   without visuals.
6. **Motion off (`Visual effects: Off`).** Only decorative layers disappear;
   the telemetry strip keeps reporting.

## Exit criteria

- No unlabelled interactive control (count must equal 194 or justified).
- No dead focus trap; focus visible on every step.
- Any SR-specific fix lands as a code change with a test or note in the
  a11y contract (`tests/*.test.js` where applicable).
- Update `src/app.js`: structural score stays 83; replace "evidence-backed
  score 55/100 - the honest ceiling..." with the new measured figure and
  link to the recording.
- Update `README.md` roadmap row and `CHANGELOG.md`.

## Known honest gaps to re-check on each pass

- Bangla/Arabic shaping in the editor (delegated to browser text layout).
- RTL: code stays LTR by design; verify panels don't flip inputs.
- Reduced-motion path must schedule at most one frame per change.