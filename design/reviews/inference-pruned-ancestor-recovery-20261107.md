# Inference reload after ancestor pruning

## Observed failure and cause

During the connected Models walkthrough, native LAZERS settings reported **Previous renderer ownership is unknown**. All six inference switches were enabled and idle unload remained Never.

`storeGrant` prunes released ancestor entries and updates the current generation's `previous` link. `ancestors` instead began from the startup-captured `previousGenerationID`. After a successor loaded, unloaded, and loaded again, that local variable could point to an entry legitimately removed from the handoff memory.

## Fix and checks

Commit `2d545e6` makes ancestor traversal start from `generation().previous`, the current stored link. It does not weaken ownership checks or change model settings, files, backend or residency policy.

The registered main/runtime fixture now creates a renderer, releases/disposes it, creates a successor, and unloads/reloads that successor. Before the fix it failed with the exact observed error. After the fix, 21 tests across main lease, main trace, runtime lifecycle and broker passed (116 assertions). `bun run verify` applied format/lint fixes and passed type checking. Canonical GUI production build and bundle evaluation passed.

## Native activation

Rebuilding canonical GUI ended the unmerged ce72ed5 Models preview. Desktop's normal plugin bundle update loaded the canonical GUI; no extra renderer or service restart was needed. The actual indicator became Available, settings showed chat/speech ready, and Run locally returned `local GPU ready.` with 19 input and 4 output tokens. Settings remained unchanged. Native Unload from GPU showed Unloaded. Reload model returned to Ready, with chat resident. Running the same local prompt again returned `local GPU ready.` (19 input / 4 output tokens). This directly exercised the same-renderer unload/reload path after the fix. [Native result](artifacts/inference-pruned-ancestor/recovered.png).

This proves the targeted failure and initial live recovery. It does not establish that every inference, renderer freeze or battery problem is fixed.
