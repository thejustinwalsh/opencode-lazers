# Local inference reconnect

2026-11-02. Root correction `2e1d4e8`.

Desktop displayed `Local model disconnected: [object Object]`, Error, no resident
model, with all six switches enabled and idle Never. Default/project direct and
forwarded settings RPCs still answered in 2–3 ms in service PID 7793. This does
not establish the initiating transport error or a GPU device failure: formatting
had discarded the structured RPC message.

The renderer unloaded on any mailbox polling failure, then waited for new
inference demand because startup was not rearmed. The actual production lifecycle
fixture reproduced the unreadable error, then separately reproduced failure to
reattach after the mailbox became available again.

The correction keeps reconnect intent across failed attachment and load attempts,
uses increasing delays capped at 30 seconds, and resets the delay on success.
Disabling inference or manual unload cancels automatic loading. Cleanup failures
retain exclusive ownership. Delivered inference is not replayed. Native structured
RPC type/message is shown without dumping the error payload.

Checks: 106 WebGPU tests / 532 assertions pass, including real production runtime
fault injection, no-demand reconnect, failed reattachment/backoff, disable during
reconnect, manual unload and exclusive allocation/failed cleanup. Formatting,
lint, typecheck, diff check and GUI production build pass. Build retains existing
ONNX CommonJS import-meta warnings; no backend or inference settings changed.

Native observation: built Main GUI activated through Desktop View → Reload.
No background-service restart. The enabled runtime automatically loaded cached
chat and reached Ready / apple. Desktop Run locally returned `local GPU ready.`
with 19 input and 4 output tokens. No profiler was armed. This proves loaded native
chat generation, not a fresh live transport-failure/reconnect cycle. The built-in single-device-loss test then recovered automatically to Ready;
a fresh typed decision returned `{"ok":true,"kind":"boolean","value":true}`
both before and after that actual device loss.

A second regression reproduced the permanent repeated-loss stop after its window
had elapsed. Root `4d5ce21` changes that stop into a one-minute cooldown followed
by automatic recovery; an explicit new request can still try sooner. The fixture
proves no allocation during cooldown, recovery with no queued request after the
window, successful fresh inference, and early explicit retry. All 106 WebGPU tests
/ 532 assertions and quality pass afterward. This later correction is committed
but not yet activated or observed natively: Desktop locked before the next GUI
activation. One unlock request is pending; the native worker continues.
