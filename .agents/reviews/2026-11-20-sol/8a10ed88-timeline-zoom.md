# 8a10ed88 — timeline-zoom

## Findings

### 8a10ed88-1 — minor / confirmed

- **Where:** `src/trajectory-panel/panel.tsx:932,1645-1659,1889`.
- **What:** Expanding promotes only the timeline to a modal dialog; the selection inspector remains outside it and becomes inert. Selection still updates that inaccessible inspector.
- **Failure scenario:** Expand and select a tool call; try to scroll/copy its details with the keyboard. The detail pane cannot receive focus until the timeline is collapsed.
- **Evidence:** `showModal()` applies to the dialog inside `DetailsPane.top`; inspector is the separate body at 1648-1659. No inspector is rendered inside the dialog.
- **Suggested fix / test:** Include details in the expanded surface or expose an explicit inspect-and-collapse action. Test expanded selection and keyboard access to the selected call's details in a real browser.

## Checked and sound

- `bun test test/trajectory-panel/viewport.test.ts`: 7 pass, 0 fail, 31 assertions, 43 ms.
- Anchor zoom math clamps zoom/scroll to valid ranges.
- Pinch has a non-passive listener; ordinary wheel releases to the page at either end.
- Drag slop preserves clicks; suppression is limited to the drag-ending click.
- Escape/close sync expanded state and restore inline presentation.

## Not reviewed

- No browser focus-trap, pen/pointer-capture or reduced-motion walkthrough.
