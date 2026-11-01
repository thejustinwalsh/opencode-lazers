# LZ-28 retain-and-reconcile execution brief

2026-11-01. Continue original task `239f45a9-3247-4cba-b339-19c8267d0800`,
not a replacement task. Original objective, configurable idle default, selected
route/history preservation, native archival and exact-artifact dogfood remain.
Disabling renewal on the supported host is not completion.

## Clarified intent and evidence

The user explicitly rejected requiring an atomic fence over every native
admission. They then selected **“Preserve work, honor cancels”**: reconcile
pending/delivered inputs and outcomes and honor pause/cancellation; no complete
audit of foreign inputs deliberately cancelled before LAZERS first observed them.
This clarifies accounting, not permission to abandon pending work or waive races.

Native source investigation and a zero-inference probe established that public
HTTP archival works and preserves retained history/pending rows. The plugin
`session.update` adapter omits `archived`, so use the working supported client
route with readback rather than claiming the adapter archived anything.
The probe's admission/cancellation log contained only sequence markers after
cancellation: do not infer event retention from `log.synced`.

Sources and remaining limitations are in `upstream-gap.md` beside this file.
All pinned upstream findings refer to OpenCode 2.2.5 / `9bbb8ce18c80f099e0e448775f59d965ead40a21`.

## Protocol and required invariants

- Before native effects, persist renewal identity, fixed successor/route,
  explicit continuity checkpoint and its input coverage, stable handoff identity,
  covered plan versions and a durable predecessor reconciliation-source record.
- Known busy/recent owners remain ineligible. Recover ambiguous successor creation
  with exact-ID readback and lineage/route validation. New observed busy work can
  defer archival; it is never interrupted or resubmitted by renewal.
- Transfer covered plan ownership, checkpoint linkage and reconciliation
  responsibility atomically under the existing scheduler fence/CAS. Detect plans
  added during preparation. Persist handoff before predecessor archival.
- Archive through the working public client route; read back the property.
  Lost/negative/unavailable readback remains a recoverable phase, not success.
  Archival failure after transfer does not resurrect predecessor authority.
- Retain the archived predecessor as a recovery source across restart and later
  renewal generations. Empty inbox/unchanged idle time cannot retire obligations.
  Reconcile inbox plus paginated full message history, not compacted context alone.
- Journal native input IDs and their pending/steering/delivered/cancelled/unknown
  dispositions separately from business-action receipts. Native promotion moves
  the original ID into history atomically. Never cancel-and-copy or replay an
  original request, completed tool or uncertain external action into the successor.
- Preserve `resume:false`. Pending source references must remain discoverable
  without a terminal marker; merely referencing them never authorizes execution,
  waking, answering forms or transferring permission grants.
- Busy-period terminal markers account for a period, not proof every steered
  instruction completed. Keep partial/failed/interrupted obligations explicit;
  correlate worker outcomes by their existing attempt/session/message identities.
- Refetch mutable assistant/tool rows at terminal readback before finalizing a
  scan. Shutdown is not a terminal marker. Persist pagination/dirty-row cursors
  and perform fair incremental work in native pagination order.
- Persist each notification's target/message identity before admission. Preserve
  and reconcile ambiguous sends even if the owner changes meanwhile. Resolve
  current owners from live durable state, not recursive model forwarding.
- Authenticate generated notification IDs against the ledger. Suppress
  notification-only response loops without suppressing mixed substantive input.
  Revision pending-source objects so new paused input is visible without a new
  terminal marker.
- Close the `reassign` owner-check exception: a retired predecessor reading the
  latest plan version must not reclaim transferred plans. Preserve deliberate
  recovery authorized by a legitimate active caller and harmless receipt replay.
- Explicit continuity must preserve conversation-only decisions and unresolved
  questions, with coverage and subsequent source references visible before a
  conflicting continuation. Plan IDs or a bare predecessor link are insufficient;
  do not replay or automatically summarize the whole old transcript.

## Discriminating checks and native completion

Exercise actual public-admission shapes during creation, transfer, archival and
after archival, including unchanged idle timestamps and paused input. Test
queue/steer/promotion/cancellation races, already executing tools, multiple steers,
partial failure, mutable rows between pages, shutdown, compaction, two schedulers
and reopen/lost-response boundaries. Assert original IDs/receipts, no added replay,
current-owner outcome links, retained consent and unchanged worker sessions/routes.
Test A→B→C renewal, generated-only turns and new pending inputs for loop suppression.

Real native dogfood must show busy reuse, actual idle renewal, visible archived
predecessor, continuity and late input/results while workers continue. Required
human evidence remains outstanding until observed against the returned artifact.
Unknown measurements remain unknown; reference-only handoffs are not proven
provider-cache savings.

## Preserve current main and prior work

The user's `2536084` fixes stale receipt reuse after a resumed attempt changes its
commit. It is activated in the native scheduler; the historical false failure
and unnecessary second attempt remain recorded. Preserve that source fix during
eventual integration; do not overwrite it with an old runtime file.
Privacy `15eff84` and reviewed history/navigation `74ffb3a` are independent work
on main. No GPU/settings/engine change, host-private API, daemon, replacement
worker or alternate implementation dispatch is authorized by this brief.
