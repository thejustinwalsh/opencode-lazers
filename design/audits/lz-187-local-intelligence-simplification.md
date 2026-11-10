# LZ-187 scoped audit — optional local intelligence coherence

Task 78d85838-0928-4854-ade3-61040322c334. Scope: `src/webgpu/**`,
`src/review/**`, `test/speech/**`, `design/audits/**`. No new inference
capability, model download, settings/default change, pricing change,
performance claim, acceptance gate, or roadmap rewrite.

## Audit record (durable, not checkout JSON)

- Baseline run `997963cd-0b5b-4631-871c-52dcac1b92fc` (phase baseline).
- Follow-up run `9dfec19b-6a86-40a9-a85a-4b27ccd1c801` (phase follow-up,
  baseline linked). Report bytes live outside the worktree in the LAZERS audit
  store; retrieve with `lz-get-audit`. No `design/audits/*.json` copies were
  made per current guidance.
- Filtered inspection used `lz-get-audit({runID: baseline, path: "src/webgpu/",
limit: 50})`: `totalFindings: 223` for that prefix, paged via `nextOffset`.
  The first page (offset 0) confirms the in-scope groups dispositioned below,
  including `deadCode/unused_exports/137` and `/138` and
  `duplication/clone_groups/5`, `/26`, `/48`, `/63`. Raw Fallow totals are
  cited only for before/after scope; grouped dispositions below are the durable
  audit evidence.

## What changed (net simplification, behavior preserved)

1. `src/webgpu/tools.ts`: added `guardedCall` helper. The three
   `editor.add` blocks (`lz-local-system-one`, `lz-local-ask`,
   `lz-local-decide`) shared the permission-assert plus `Effect.flatMap` /
   `mapError` / `JSON.stringify` pipeline; all three now call one helper with
   their own feature, action name, input schema, and RPC invocation. The helper
   context is `Pick<Tool.Context, "sessionID" | "agent">`, so native branded
   session/agent identity flows directly into `permission.assert` with no
   `unknown` widening or `as never` casts. Tool names, descriptions, inputs,
   permissions, and error text are unchanged. `src/webgpu/tools.test.ts` adds
   registered-tool coverage for all three action/session/agent forwarding
   values, denied permission with no RPC, post-registration feature disable
   with no RPC, and RPC error conversion.
2. `src/webgpu/speech.ts`: added `assistantReplyText` helper. `latestResponse`
   and `completedTurnResponse` (via `latestCompletedResponse`) shared the
   final-answer/commentary plus tool-boundary filtering block; both now call
   one helper with the same chronological, idle, completion, and error fences.
   Response shapes and empty-string fences are unchanged.
3. `src/webgpu/rpc.ts`: added `sharedInferenceMethods`. `LocalInference` and
   `RendererInference` duplicated the same eight method definitions
   (`settings`, `configure`, `review`, `ask`, `speak`, `decide`, `systemOne`,
   `transcribe`); both now spread one table. The renderer mailbox keeps its
   own `id` and ownership primitives (`demand`, `attach`, `detach`, `poll`,
   `complete`). RPC IDs, method names, and schemas are unchanged.
4. `src/webgpu/review-questions.ts`: removed the dead
   `export { REVIEW_ROUNDS, REVIEW_THRESHOLD } from "../review/progression.ts"`
   re-export line. Confirmed zero callers import those symbols through
   `review-questions` (`task-review.ts` imports `REVIEW_ROUNDS` from
   `../review/progression.ts` directly; no file imports `REVIEW_THRESHOLD`
   through `review-questions`). Canonical exports in `src/review/progression.ts`
   are untouched; `REVIEW_VERSION`, `reviewChecks`, and `reviewQuestions` are
   unchanged.

No prompt, permission, schema, RPC/IPC export, persisted-data, lease, or
review-progression change. Lazy ONNX/tokenizer/model assets, GPU fixes, cache,
and configured ON/Never preferences are untouched. No semantic-search download.

## Result

- Dead code: total issues 278 → 276 (the removed re-export line accounts for
  the two resolved export findings in the raw report). All other scoped
  `unused_export` / `unused_type` / `unused_class_member` signals are false
  positives confirmed by caller grep and retained: `DecisionSpec` is used in
  `DecisionRequest` in the same file; `CacheStatus` feeds both `status`
  outputs in `ipc.ts`; `ENGINE_REVISION` builds `ENGINE_URL` and
  `DECISION_REPOSITORY` builds `decisionURL` in `manifest.ts`;
  `DECISION_CONTEXT_CAPACITY_TOKENS` is read in `decision-runtime.ts`;
  `recoverable` is read in `lifecycle.ts`; `Finding` is the `TaskReviewer`
  result shape; `InferenceTrace` / `RendererCaptureStatus` back IPC schemas
  and tests; `InferenceTraceSpan` backs `startInferenceTrace`;
  `InferenceTraceBuffer.clear` is a deliberate bounded-buffer primitive (sibling
  `Map.clear` calls in cache/speech paths are unrelated).
- Duplication: clone groups 199 → 196, instances 440 → 433, duplicated lines
  4244 → 4173, files with clones 100 → 98, duplication 3.41% → 3.35%.
  Resolved in-scope families: `tools.ts` tripled guard/permission/RPC block,
  `speech.ts` assistant-text filter pair, `rpc.ts` Local/Renderer method table.
  Remaining scoped clones (`ipc.ts` vs `lease.ts` lease-ID shape, residual
  `speech.ts`/`task-review.ts` overlaps) were left intact: unifying them
  would move schema/lease ownership across boundaries without reducing total
  complexity.
- Health/complexity: `runtime.ts` `tick`/`run`/`acquireLease`/`ensureModel`,
  `lease.ts` `acquire`/`lost`, and `task-review.ts` `verify` remain above
  thresholds. No function splits were made; splitting them would relocate
  lease/handoff branching without reducing total complexity, and the lease,
  generation, and recovery fences must stay exact.
- `src/review/progression.ts`: no edit. `REVIEW_ROUNDS` / `REVIEW_THRESHOLD`
  defaults and the shared replay/round/progression policy also serve
  `src/recovery/handoff/review.ts` and `review-state.ts`; behavior is
  preserved and review remains advisory.

## Finding dispositions

- Durable grouped dispositions linked to the follow-up run (append-only, via
  `lz-record-audit-finding`):
  - `.../deadCode/unused_exports/137` → `fixed` (request `lz-187-repair-137`).
  - `.../deadCode/unused_exports/138` → `fixed` (request `lz-187-repair-138`).
  - `.../duplication/clone_groups/5` → `fixed` (request `lz-187-repair-g5`).
  - `.../duplication/clone_groups/26` → `fixed` (request `lz-187-repair-g26`).
  - `.../duplication/clone_groups/48` → `fixed` (request `lz-187-repair-g48`).
  - `.../duplication/clone_groups/63` → `fixed` (request `lz-187-repair-g63`,
    same `guardedCall` consolidation as group 26).
- Remaining scoped `unused_export` / `unused_type` / `unused_class_member`
  signals outside those groups were not dispositioned here and remain retained
  as false positives with callers listed above; health findings above
  thresholds were intentionally left intact. No analyzer finding was
  suppressed and no code was moved elsewhere to manufacture improvement.

## Checks

- `bun run verify` (fmt, lint --fix, fmt, check): pass, no type errors, no
  lint problems.
- `bun test src/webgpu src/review test/speech src/recovery/handoff/review.test.ts`:
  149 pass, 0 fail, 1026 expect() calls across 29 files.
- Dynamic/native entry points confirmed live and retained: `Rpc.define`
  `LocalInference` / `RendererInference` exports, `ModelFiles` IPC surface,
  lazy ONNX/tokenizer/model assets, and `TaskReviewer` registration in
  `server.ts`. `Rpc.define` returns definitions without mutation; the shared
  method table preserves that behavior.
