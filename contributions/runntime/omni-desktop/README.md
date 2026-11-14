# Isolated Omni Desktop candidate receipt

**Status: incomplete and unqualified.** Liquid remains the default. The
ruNNtime route stays explicitly selectable for a controlled probe and does not
fall back automatically.

## Exact candidate identity

The retained LAZERS candidate baseline is commit
`cde3941d4555970cc3086df50573b907350eee67`. The exact LAZERS implementation
tree for this receipt is commit `17848b7fe71f2228072b295a5ded087626684148`,
built on commit `4b8701de59de858072eb70656e0a9effb03c965f`, which introduced the
contract and provenance increment. It requires
`webgpu-generation-result-nullable-usage-v1`. Rebuild the GUI from that candidate
source revision (or a checkout retaining those sources), not from the
baseline-only bundle; use the verification and `bun run build:gui` commands below.
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

Check that `git -C "$LAZERS" rev-parse HEAD` reports
`17848b7fe71f2228072b295a5ded087626684148` and
`git -C "$RUNNTIME" rev-parse HEAD` reports the sibling package revision above.
`bun add --no-save` is a workstation-only override; do not retain it in either
LAZERS manifest or lockfile. The built GUI bundle is self-contained for the
isolated candidate. This procedure is not evidence of a portable published
ruNNtime dependency or distribution readiness.

The rebuild order is `bun run verify` followed by `bun run build:gui` after the
no-save override. Keep both revision checks visible in the probe record: the
LAZERS candidate implementation above and the sibling package revision here.

## Required activation order

The rebuilt GUI and service must both report/accept
`webgpu-generation-result-nullable-usage-v1` before any candidate probe. The
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

The matching candidate GUI was built from LAZERS code revision
`17848b7fe71f2228072b295a5ded087626684148` with the pinned sibling package. The completion-contract service reload and Desktop-only
reopen have not been performed by this worker, and no Desktop interaction occurred.
The supported launcher found the existing ready isolated root
`lazers-full-instance-qk2Laa` for the canonical workspace and refused a competing
trial. Per Architect direction, the prior root, reservation, Desktop, service,
and worker sessions remain untouched. Architect will inspect supported
candidate activation/Desktop-only reopen while preserving that service and its
sessions. Actual rendered chat, clean-clip dictation, audible playback, and
recovery therefore remain pending, not passed.
