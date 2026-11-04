# Logical correction coverage — 2026-11-04

Research/planning for existing LZ122, not a benchmark or new execution/approval gate.
Preserve actual separate tasks, attempts, ACCEPT events, artifacts and measured work.

## Superseding user decisions and executable foundation

The earlier provisional unknown-count guidance below is historical, not the final
product policy. User explicitly chose **Separate by default** for unlinked tasks,
disclosing legacy independence as unreviewed, and **Latest genuine acceptance**
among explicitly linked members. No manual certification step or new reviewed
fulfillment witness is required. **An unfinished linked required correction keeps
the logical goal unfinished**; an older physical acceptance cannot certify logical
completion while that correction is pending. Relation metadata never creates or
overrides native acceptance. Root creation/submission and root
classification select goals while retaining every later member's work. Credit once
to the accepting exact route; its empirical sample includes the goal's cross-route
history, without redistributing unrelated failed-only work.

Producer regression boundary: root A accepted, required correction B unfinished
means one logical goal but no logical completion/accepted-history sample; retain
A's physical acceptance and both members' effort. Once B has genuine artifact-backed
acceptance and no required correction remains unfinished, credit the logical
completion once to the latest genuine accepting route, including all goal effort.
A pending required branch cannot disappear behind another branch's acceptance.
These are consumer122 accounting checks, not a new manual certification workflow
or a126 authority to alter native outcomes.

Durable explicit linkage is required now, not permanent unknown handling. LZ126
`2ba384f5-142d-46ff-abd0-c6fe2ae19f2c`, plan
`c64e0231-b47c-4432-96a9-5e5e39fe6a6b`, owns neutral native annotations and coherent
SELECT-only readers. Existing LZ122 planv5 now waits for it. Record119+124 and120+125
through reviewed activated native controls, never direct DB edits or production
ID hardcoding.121/123 remain separate evolution. Preserve all physical history.

## Real dogfood case

LZ119 (`8d324858-260e-48b9-bc7c-1825666717e4`) already required recovery replay
idempotence **including `recorded_at`** in `compatible-accounting`. LZ124
(`b2f262ab-bbe7-476b-9437-3bfe22edabdd`) corrects that unmet assertion. Both physical
records are bug repairs with ACCEPT events; intended accounting is **one original
logical outcome with all correction effort**, not two successes or omitted repair cost.

- LZ119: attempt `34a9cf97`, artifact `e4d64ad`, acceptance/artifact transitions
  8656/8657. LZ124: attempt `9fdce7eb`, artifact `d1b2b74`, transitions 8724/8725.
- Plan `4195aed2-f292-4678-9ed1-f0cf9d9e4e39` records **124 supplements 119**,
  explicitly describing a correction to the existing boundary.
- Both frozen routes are `openai/gpt-6-luna#max`, systems. Frozen routes are not
  observed allocation evidence.
- No task disposition or adoption exists for the pair. The plan relation exists
  independently in plan/revision bodies and `runner_relations`.
- Integration transitions 8755/8756 and 8762/8763 record corrected landing `f23fcb1`
  while preserving distinct receipts. Ancestry corroborates implementation history,
  not a general task-equivalence rule.

LZ125 similarly corrects LZ120's already-explicit needed-rate assertion; its plan
records same-original-outcome intent. A new correction execution record must not
improve efficiency merely by adding another logical success.

## Existing surfaces and limitations

- `src/runner/schema.ts:107–117,153–157` and `src/runner/store.ts:2249–2287` retain
  distinct/supplements/duplicate relations. **None is a machine-defined correction
  root.** Supplements also describes additional work: LZ121/123 extend LZ108 beyond
  its prior boundary and must not automatically collapse into it.
- Task dispositions (`src/task-disposition.ts`, `src/storage.ts:653–682`) retire
  records; related IDs have no root/direction semantics. Do not manufacture duplicate
  or superseded dispositions to fix the metric.
- Adoption, integration, Architect/session ancestry and context references do not
  associate another task's work with the same original acceptance.
- The current ledger reduces acceptance to 0/1 per task ID and exposes no correction
  root. Session/occurrence deduplication is measurement identity, not intent identity.

Reviewed human-readable evidence supports this specific correction interpretation,
not automatic prose/kind/scope/ancestry/session-parent/supplements inference.

## Current LZ122 decision

Its v4 planning reason preserves existing dependencies and requires:

1. Preserve every physical record and all effort.
2. With supported explicitly reviewed root membership, aggregate members once using
   root creation/submission time and classification, retaining all later histories
   and member metadata.
3. Credit corrected acceptance once to the accepting exact configuration. Keep
   configuration effort separate; accepted empirical history includes its own
   correction/retry work, not unrelated failed-only work.
4. Without authoritative membership, visibly withhold unsupported logical counts,
   efficiency/frontier points and complete-history claims. Never substitute physical
   counts, zero, or lower bounds; do not silently exclude repairs or misclassify
   them as task-kind exclusions.

V2 has unavailable/unknown paths, but mandatory cohort counts are integers, not
nullable unknowns. `partial` cannot legitimize false counts. Withhold affected
count-bearing results or explicitly fail the measurement read as unavailable; do
not manufacture a found row or return empty **success**. Explain unresolved
cross-task correction lineage visibly. A partial context note alone is insufficient:
the consumer reliably surfaces `unavailableReason` for backend-not-ready, not every
partial result. Do not claim complete history for LZ119's own attempts alone.

No wire expansion is automatically required for honest limited results. Future
neutral append-only root annotations or unknown-count-bearing rows need an explicit
contract; never hardcode this project's task IDs or silently reinterpret fields.

## Discriminating tests — not measured costs

Use real identities with clearly test-controlled arithmetic:

- Accepted 119 on A: 100 tokens/$1; accepted 124 on B: 50 tokens/$2.
- Known root membership: one logical completion rooted at 119. A retains 100/$1
  and zero credit; B retains 50/$2 and one credit. B's single empirical observation
  is **150 tokens/$3, cross-route**, not two samples.
- Same exact configuration: 150 tokens per accepted task, not 75 or 100.
- Both physical accepted attempts remain accepted; do not relabel 119 failed or
  124's first physical attempt a runtime retry just to fit the accounting.
- Root-period membership retains a later correction outside the window. A window
  containing only correction creation must not invent a new original task.
- Separate LZ121/123 evolution remains separate. Unrelated failed-only work changes
  cohort effort, not accepted-history samples.
- Unresolved membership yields a visible limitation, no certified logical count or
  complete-history point. Relation-relevant changes bind new capture/cursor identity;
  paging must retain correction contributors.
- Unique-session deduplication, cumulative-versus-additive selection, observed routes
  and unknown pricing remain intact.
