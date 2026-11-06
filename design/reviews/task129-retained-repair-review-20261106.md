# LZ-129 retained repair: current source review

Root inspected the original worker's uncommitted patch, 2026-11-06. This is review feedback, not acceptance. Worker and history remain intact.

**Open: repeated historical migration scan.** In the current `src/runner/store.ts` patch, the new correlated `UPDATE runner_attempts SET project_directory=(SELECT …) WHERE project_directory IS NOT (SELECT …)` executes unconditionally inside every `RunnerStore` constructor, after the missing-column branch. Even an already migrated store scans historical attempts on normal location initialization/reopen. Keep necessary additive upgrade/backfill/index and consistency maintenance, but avoid repeating the backfill scan on ordinary opens; verify upgrade and reopened-store behavior. This stays within the approved query/index scope and needs no replacement attempt or general schema redesign.

Current native results: 17 focused tests/80 assertions pass; `src/runner/runtime.test.ts` reports 137 pass and two five-second timeouts. These do not establish complete acceptance. No worker files or runtime source were changed by Root. Desktop follow-up receipt for the broader Models/pricing continuation is `msg_1b2775fe80011WkNsIBR16Mvqc`; this specific review feedback still needs a verified native receipt.
