# 70a0f10e — radar-flow-animation-2

## Findings

### 70a0f10e-1 — minor / confirmed

- **Where:** `src/radar/pulse-loop.ts:244-255,296-299`; `src/radar/flow-view.tsx:78`.
- **What:** Compositor animations do not subscribe to reduced-motion changes. Existing infinite animations keep running until a data/layout update; the view's static-dot mode is frozen at mount.
- **Failure scenario:** Open an active Flow canvas with reduced motion off, then turn it on while layout/data remain unchanged. The OS preference changes but no code cancels/pauses the animation. Even a later update winds it down as if a wire stopped instead of immediately becoming static.
- **Evidence:** Loop samples `reducedMotion()` only in `update`; `wake` handles visibility only. `still` is a plain mount-time boolean. CSS's reduced-motion rule targets node pulses, not these flow dots. Tests cover reduced motion only before the first update.
- **Suggested fix / test:** Subscribe to media-query changes and dispose that listener; immediately stop motion and render static markers, restoring animation on opt-out. Test toggling both ways after animation begins with no new snapshot.

## Checked and sound

- Reviewed exact range `9261988a..70a0f10e`; stable keyed rows address insertion/removal identity independently of animation geometry.
- Animation reshaping preserves phase; stopped wires let existing crossings finish; hidden views pause/resume.
- Disposal cancels Web Animations, removes dots and unregisters the visibility listener.
- `bun test src/radar/pulse-loop.test.ts`: 7 pass, 0 fail, 47 assertions, 311 ms.
- The no-write test's asynchronous-observer gap is recorded once under its originating unit, `c20db866-1`.

## Not reviewed

- No actual compositor, paint or accessibility walkthrough; fake animation hosts do not prove browser frame cost.
- Pulse keyframe density and visual equivalence were not measured across display refresh rates.
