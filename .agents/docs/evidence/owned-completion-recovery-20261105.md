# Owned completion and recovery controls

## Explicitly approved ownership transfer

The operator approved **only** original LZ129 and LZ132. Supported
`lz-plan-command action:reassign` changed their current owner from
`ses_5aa94658965844ed85f4b0ebdd5266cb` to
`ses_e568438ebffeaoFbF9nBb942XM`:

- 129 plan `243f8093-7c3c-44e3-bda5-e06870e4f680`: version25→26.
- 132 plan `10964078-2262-4b2c-8f5a-101222a16e55`: version12→13.

Original attempts remain `58d8d699-6a12-44c3-a5af-954b2b5564bc` and
`547ae78b-1300-47fe-9aa4-d43461a54379`; no replacement, prompt, SQL rewrite or
worktree mutation was performed. No other legacy plan transfer/delegation is
authorized. The historical owner remains stopped, natively interrupted/idle at
1793847176491; do not wake its historical-notice loop.

## Delivered owned source and unresolved lineage

- 133 corrected artifact `f5f7af4badbb1093ab80d3e203f060afe1d72cd0` is clean.
  Independent Luna source review found no remaining cursor blocker. Architect
  reran16 tests/260 assertions, format/lint/typecheck successfully.
- Root's migrated actual-database disposable clone reprobe returned4657 unique
  records/95 pages; unrelated observation activity preserved traversal and a
  selected-journal mutation invalidated its cursor. Migration26.33ms,
  traversal/checks55.52ms. Production remained read-only and cleanup was confirmed.
  This is component/migration evidence, **not registered native acceptance**.
- 135 corrected artifact `335cd57` atop `3a85ecd` is clean. Root's reprobe produced
  `[24,0,0]` for8 sessions and `[120,0,0]` for40; the expanded fixture covers122
  sessions and unrelated external writes. Architect reran66 tests/624 assertions
  and format/lint/typecheck successfully. Independent Luna review is pending.
  Native quiet CPU benefit remains unmeasured.
- Native review steers were genuine:133
  `msg_c9ffde5810784b15b6b62006616426e4`;135
  `msg_118166ff437e4ce6b18e68161896467b`. Both were `delivery:steer`, `resume:false`.
  Runtime recognizes initial assignment/progress-reminder aliases, not these
  review inputs. Plans133v5 and135v7 are now blocked on matching-input lineage.
  Do not rewrite initial IDs, fabricate idle, re-prompt for certificates or label
  review inputs as reminders to clear this gate.

## Narrow repair and exact admission boundary

LZ136 `06fc208a-e4ed-4fe6-9b5b-33905840f8a8`, plan
`ad6cb637-d5d7-4ee4-974e-727216f2bdd5`, is admitted for Luna Max at priority2300.
At version2 it has **zero attempts**, not an executing worker. It adds explicit
owner-authorized, native-observed review-input reconciliation with durable
provenance/race fences, preserving original assignment and ordinary verification.
Its scope avoids133's store/tools and135's recorder files.

Legacy72 still reserves `src/runner/runtime.ts` and its test under uncertain
`verify:runner` effect
`cd7cb493807b9dbcc552f552586351cbdb78d420baee04da31440ac86c36a8f8`.
The repair cannot bypass that source admission. Existing `quarantine-source`
requires the plan owner (`runtime.ts:486,539`) and preserves uncertain resources;
the approved129/132 transfer grants no control over72. Root assistance must use
authorized supported maintenance, not caller spoofing or direct lifecycle SQL.

## Retained quota failures and execution order

129/132 remain natively failed but runtime-running with unknown background.
Existing resume rejects that state. Cancel→settled→same-attempt resume preserves
identity mechanically, but the current admission path does not freshly fence
unknown background before prompting. Cancellation is therefore not a proven safe
clearance workaround. No new worker input was sent.

Order remains:136 truthful steering reconciliation; ordinary133/135 runtime
verification, final review, Root live gates and integration; then134 notification
coalescing. Resume129/132 through a truthful supported path, retaining their review
findings. Keep126→122 production Models prerequisites and108's connected graph
gate, followed by approved graph/UI completion, editable assignments and actual
persona-to-dispatch wiring. Saved read-only mappings do not deliver those features.

All subsequent research/implementors remain OpenAI `gpt-6-luna/max`; Architect
stays Sol High. Root owns Desktop and native verification. Local authoring review
hit WebGPU device loss and supplies no semantic acceptance.
