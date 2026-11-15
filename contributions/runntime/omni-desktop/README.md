# Isolated Omni Desktop candidate receipt

**Status: incomplete and unqualified.** Liquid remains the default. The
ruNNtime route stays explicitly selectable for a controlled probe and does not
fall back automatically.

## Exact candidate identity

The retained LAZERS candidate baseline is commit
`cde3941d4555970cc3086df50573b907350eee67`. The historical LAZERS implementation
tree for this receipt is commit `17848b7fe71f2228072b295a5ded087626684148`,
built on commit `4b8701de59de858072eb70656e0a9effb03c965f`, which introduced the
contract and provenance increment. That earlier tree requires
`webgpu-generation-result-nullable-usage-v1`. The native conversation changes
from LZ-28 and the resolver/location/history repairs from LZ-30 require the v2
contract documented below. Rebuild the GUI from the current LAZERS source state
containing both increments for native conversation qualification. The earlier
candidate bundle does not support the v2 stream mailbox; use the verification
and `bun run build:gui` commands below.
The exact sibling package source is `runntime/packages/runntime` at commit
`4bec7104f2e70290982864963f6b194e6d5439fe` (package revision), based on
`6aa6bbd5a0dae14204e9853c34c911fedd430659`. Liquid remains the selected default
and the ruNNtime pair remains unqualified.

## Package source and local installation

The candidate is built against the canonical sibling `runntime` checkout at
`4bec7104f2e70290982864963f6b194e6d5439fe`. That commit is based on
`6aa6bbd5a0dae14204e9853c34c911fedd430659`; it adds only the public speech
failure-recovery test retained in `patches/0001-queued-speech-failure-recovery.patch`.
The runtime implementation and bundled API are otherwise unchanged from the
selected public API source. The exact model and tokenizer source revisions are
recorded by LAZERS in `src/webgpu/manifest.ts`.

No sibling path is persisted in LAZERS `package.json` or `bun.lock`. For a local
candidate rebuild, use the sibling source checkout and a no-save package
override:

```sh
RUNNTIME=/path/to/runntime
LAZERS=/path/to/lazers
git -C "$LAZERS" rev-parse HEAD
git -C "$RUNNTIME" rev-parse HEAD
(cd "$RUNNTIME" && pnpm --filter runntime build)
cd "$LAZERS"
bun add --no-save "$RUNNTIME/packages/runntime"
bun run verify
bun run build:gui
```

For the historical v1 candidate, `git -C "$LAZERS" rev-parse HEAD` reports
`17848b7fe71f2228072b295a5ded087626684148`. Native conversation qualification
must instead use the current LAZERS tree containing the LZ-28 and LZ-30 changes;
record its `git -C "$LAZERS" rev-parse HEAD` before building. In both cases,
`git -C "$RUNNTIME" rev-parse HEAD` must report the sibling package revision above.
`bun add --no-save` is a workstation-only override; do not retain it in either
LAZERS manifest or lockfile. The built GUI bundle is self-contained for the
isolated candidate. This procedure is not evidence of a portable published
ruNNtime dependency or distribution readiness.

The rebuild order is `bun run verify` followed by `bun run build:gui` after the
no-save override. Keep both revision checks visible in the probe record: the
LAZERS candidate implementation above and the sibling package revision here.

## Required activation order

The rebuilt GUI and service must both report/accept
`webgpu-generation-result-nullable-usage-v2` before any candidate probe. The
renderer checks the service contract before attaching; the service rejects a
renderer that does not declare that contract. A missing, mismatched, or
unverified contract is a hard stop, not qualification evidence. At the quiet
boundary managed by Architect, reload the OpenCode service first, then reopen
Desktop only so it loads the rebuilt GUI. Do not restart workers, clear
reservations, interrupt sessions, or launch a competing trial. If diagnostics
show `unverified` or `incompatible`, do not probe; resolve the required service
reload/Desktop reopen first.

## Producer regression and boundaries

The new focused unit test injects a language-forward failure into the public
audio speech runner, observes the failed `result`, and verifies that an already
queued successor still streams and completes. It covers queue recovery from
this injected operation failure only; it is not an OOM, GPU-submit/device-loss,
or pinned-Liquid speech-quality result. The base/tip/tree, ordered patch digest,
reconstruction check, and producer checks are recorded in
`producer-manifest.json`.

Existing partial receipts remain authoritative and unchanged. In particular,
run-27's recovered transcript is native self-ASR, not pinned-Liquid cross-engine
recovery. The later same-file speech deviation and outstanding independent
audio-attention/convolution/depth references remain unresolved. The partial
producer receipt does not qualify the package or the candidate route.

## Desktop status

The historical pre-native candidate GUI was built from LAZERS code revision
`17848b7fe71f2228072b295a5ded087626684148` with the pinned sibling package. The
completion-contract service reload and Desktop-only reopen have not been
performed by this worker, and no Desktop interaction occurred.
The supported launcher found the existing ready isolated root
`lazers-full-instance-qk2Laa` for the canonical workspace and refused a competing
trial. Per Architect direction, the prior root, reservation, Desktop, service,
and worker sessions remain untouched. Architect will inspect supported
candidate activation/Desktop-only reopen while preserving that service and its
sessions. Actual rendered chat, clean-clip dictation, audible playback, and
recovery therefore remain pending, not passed.

## Native conversation qualification

The native model picker exposes **LAZERS Local WebGPU** with independent Liquid
and ruNNtime LFM3 Omni text models. Qualify the ruNNtime model from an actual
native conversation, not the Settings diagnostic controls: select the ruNNtime
model, confirm ordered incremental text appears in the conversation, then send a
follow-up whose system/user/assistant history depends on the prior turn. Select
the Liquid native model afterward and confirm it remains Liquid without changing
the Settings route. Exercise interruption and a renderer/service disconnect as
well as normal completion; verify each request ends once and that no stale text
appears after cancellation. Native conversation remains unqualified until these
Desktop observations are recorded alongside the exact candidate/package
revisions above. No native picker or conversation interaction was performed by
this worker.

The historical implementation tree cited above predates the native conversation
provider. For native conversation qualification, rebuild from the current LAZERS
tree containing the LZ-28 provider and LZ-30 resolver/location/history repairs;
the former candidate build is not compatible with the v2 stream mailbox contract
and must not be used as evidence.

The native-conversation regression suite also verifies the host `aisdk:` package
gate and SDK/language hook construction, project-to-default-location streaming,
ordered message history, interruption, ownership loss/replacement, queue
survival, and a fresh request after recovery. Liquid's runtime fixture asserts
that system/user/assistant history reaches the actual engine call and that the
legacy single-prompt diagnostic still supplies one user message. These are
automated fakes/fixtures, not Desktop or GPU observations; native model selection,
real service interruption, and rendered conversation qualification remain
pending.

For this task, `bun run verify`, `bun test src/webgpu test/product-verification`
(214 tests passed), and `bun run build:gui` passed with the pinned sibling
package revision above. The bundle build emitted non-fatal `inlineDynamicImports`
and ONNX `EMPTY_IMPORT_META` warnings; its bundle evaluation passed. This is
automated verification only: no Desktop/service lifecycle or real GPU/native
conversation qualification was performed.
