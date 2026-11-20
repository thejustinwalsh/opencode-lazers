# aa3c498c — website-panel-demos

## Findings

### aa3c498c-1 — major / confirmed

- **Where:** `website/demo/src/main.tsx:64-78`.
- **What:** Settled/reduced-motion boot returns before installing the command listener. The page nevertheless offers chapter buttons and promises that they jump to a result.
- **Failure scenario:** Open the website with reduced motion enabled; the iframe loads `at=final`. Click any earlier chapter: the parent sends `seek`, but the iframe has no listener, so the image never changes.
- **Evidence:** `website/src/Demo.tsx:299-302,329,363-369` renders the settled iframe and sends chapter seeks; `website/demo/src/main.tsx:64-71` returns before `addEventListener` at 78. Later `1db0efc1` changes frame fitting, not this command handling.
- **Suggested fix / test:** Install seek handling before the settled return, without starting animation. Test a settled boot followed by a parent-origin seek and assert the selected chapter renders; the existing tests call `Engine.enter` directly and never exercise this protocol.

### aa3c498c-2 — major / confirmed

- **Where:** `website/demo/src/engine.ts:175-180,249-252`.
- **What:** Pausing stops the clock but not in-progress pointer/scroll animation loops. They continue requesting frames (and pointer messages) indefinitely while offscreen.
- **Failure scenario:** Scroll a demo out of view during a pointer move. `pause()` freezes `clock.t`; `clock.t - begin < ms` can never become false, but each animation frame posts the same pointer again.
- **Evidence:** `website/demo/src/engine.ts:21-24` cancels only the clock's RAF. `moveTo` and scroll have independent `frameDelay` loops; parent messages at `website/src/Demo.tsx:266-270` still write style each frame.
- **Suggested fix / test:** Suspend animation waiters with the clock and wake on resume; test that a paused mid-move engine schedules no repeated frames/messages and resumes to completion.

### aa3c498c-3 — minor / confirmed

- **Where:** `website/src/Demo.tsx:234-240` (moved by later `1db0efc1`, not fixed).
- **What:** The visibility callback checks `isIntersecting`, not the promised one-third intersection ratio.
- **Failure scenario:** A frame crosses downward from 40% to 20% visible. The observer fires at 35%, but `isIntersecting` remains true, so playback continues until it leaves entirely.
- **Evidence:** Threshold controls callback timing, not `isIntersecting`; `sync` sends play on the boolean recorded at 237.
- **Suggested fix / test:** Require `intersectionRatio >= 0.35`; feed observer entries at 0.4, 0.2, and 0 and assert play/pause.

## Checked and sound

- Parent validates iframe source, origin, story tag before consuming messages.
- Panel RPC adapters read current story data at call time and clone responses.
- Parent removes message, media-query and observer subscriptions on unmount.
- Story compilation sorts steps and rejects missing chapter starts; build validates recorded response shapes.

## Not reviewed

- No browser walkthrough, bundle build, or story test: builds/tests write outside the permitted review directory; browser/server execution was not used.
- Did not exhaustively verify every fixture value or every stand-in UI component against native Desktop semantics.
