# Focused Tasks correction

> Superseded for the details panes by [design/details-panes/spec.md](../details-panes/spec.md) and `DESIGN.md`. The mockup images this document links to (`tasks-focus-v2.png`, `models-approved.png`, `models-compare-v*.png`, `models-focus-v*.png`, `trajectory-review-v2.png`) were abandoned and removed on 2026-11-19; those links no longer resolve.

Reference: `tasks-focus-v2.png` (1145 × 1374). Actual before capture:
`current-panel.png`. GPT-6.1 Terra High reviewed both images and the implementation.

- One continuous native themed panel, compact title/status at left, quiet scope
  text and chevron plus matching search target at right. Approximately 20–24 CSS
  px detail insets, 32–36 px list rows, subtle selection, hairline divider.
- Optional native extra panel entry; opened tabs are closable and never pinned
  or selected as a fallback. Closing must survive a render and reopening.
- The reference's half-height list contains six rows. Real sparse lists use a
  content-aware initial split, preserving any explicit user resize.
- Derive a word-boundary display label, at most 72 characters. Do not infer or
  store a new semantic title. Two-line heading maximum, short reference with full
  identity accessible. Preview the exact objective and first three criteria;
  explicit expansion exposes all text and all criteria. Done when remains a
  visible checklist (latest user correction). Details and Activity are collapsed
  by default. Descriptive text uses native Markdown; commands use native code.
- Square acceptance markers denote requirements, never passed evidence. Full
  specification and recorded submission activity remain behind disclosures.
  The full JSON specification uses native code highlighting in a separately
  scrollable region capped at the smaller of 24rem and 45vh; it starts closed.
- Inherit host fonts and semantic tokens. No invented groups, execution states,
  dependency reasons, or rows to fill the mockup.

Acceptance: inspect the connected Desktop panel with the actual verbose record,
compact header/search open and closed, optional tab close/reopen, narrow width,
keyboard disclosures, and host appearance changes. Code checks do not establish
visual fidelity.
