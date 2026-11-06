# LZ-129 cleared-permission holds: existing LZ-88 regression

Read-only Luna investigation plus Architect task reconciliation, 2026-11-06. No product changes, tests, permission grants, worker prompts or restarts were performed for this investigation.

## Evidence and cause

The v69 episode contained a real transient permission: `per_1b26d64ef001ioB5wjt5SyPk1J`, on original worker `ses_aeff3e9ac5d24c6c944d35e31b050963`, for an in-scope `src/observability/live-store.test.ts` fixture correction. Revalidation found it settled before any reply, so no grant was sent. The settling actor is unknown. Prior empty queues do not prove their earlier positive observations were fabricated.

The native adapter reads the exact worker location and session (`src/runner/native.ts:165–232`). Detailed observation conservatively retains the maximum approval count from before/after inventories and marks changes unstable (`:565–581`); a request settling during the read can legitimately yield a hold.

The runtime returns for busy, pending-input, unstable or no-outcome observations before invoking transient-wait restoration (`src/runner/runtime.ts:7404–7406`). Approval-wait restoration exists (`:6422–6445`), but this path reaches it after terminal observation (`:7241–7247`, `:7317–7324`). Existing terminal-success coverage does not establish mid-turn clearing (`src/runner/runtime.test.ts:7801–7841`). These are investigator source locations as observed, not stable line-number promises.

The runner polls every two seconds (`src/index.ts:148–165`), so this is not simply a missing polling wake. Explicit reconciliation clears recorded blocking without prompting; a later genuinely positive inventory can reblock. Persisted approval events contain counts, not request identities, and cannot distinguish an old request from a newly created one.

## Existing acceptance owns the correction

**LZ-88 already requires exactly this repair**, including stale-observation fencing and fresh zero-approval clearing while the same worker remains busy. Its earlier LZ-147 reproduction and queued scope remain authoritative. Do not create duplicate work, add this to LZ-129's publication scope, or silently widen LZ-134's coordinator lane. Preserve the existing LZ-138 → LZ-88 integration order and native reservations.

Within LZ-88, clear only an approval-specific hold after a stable exact-worker observation reports zero permissions and zero forms, before the busy/no-outcome return. Retain owner/control-version/input/session fences, real permissions, unknown/unstable inventories and unrelated holds. No permission reply, new prompt, restart, replacement attempt or fabricated idle is needed.

Regression boundary: busy worker with permission clearing; repeat identical zero observations without state/notification churn; genuinely new permission reblocks; unstable/unknown or foreign-worker observations do not clear; pre-reconcile deferred observations cannot overwrite reconciliation, cancellation or reassignment. Preserve the same input/worker/usage/history and distinguish annotations from authoritative state publication.
