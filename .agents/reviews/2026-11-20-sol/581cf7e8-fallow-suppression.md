# 581cf7e8 — fallow-suppression

## Findings

### 581cf7e8-1 — minor / confirmed

- **Where:** `src/audit/suppression-flow.ts:38,157-167,187`.
- **What:** Supplemental suppression findings can share IDs when two comments in one file have the same kind/reason; they bypass the main package's unique-ID pass.
- **Failure scenario:** Two newly stale comments in one untouched file both say `consumed by AB-1`. Both extras get the same ID. After removing one, ID-based disposition comparison cannot distinguish the fixed comment from the remaining one and can mark both remaining.
- **Evidence:** `staleFinding` and unconsumed IDs omit line/occurrence; `withExtraFindings` prepends extras after `buildPackage` ran `uniqueIds`. Dispositions compare only ID sets.
- **Executed reproduction:** `review-invariants-reproduction.test.ts` adds two stale comments at lines 10 and 20 with the same reason, removes one, and receives two `remaining` dispositions. Supplemental IDs are identical.
- **Suggested fix / test:** Assign stable distinct identities to supplemental findings before comparison. Test repeated kind/reason comments, then remove one and assert exactly one fixed disposition.

## Checked and sound

- Suppression metadata preserves reason and kinds separately from symbol text.
- Consumer detection confirms staleness with dead-code analysis instead of trusting a name match alone.
- Plan review distinguishes stale from still-unconsumed suppressions.
- Tests cover a consumer that changes only the importing file, not the suppressed declaration.

## Not reviewed

- No WASM/repository tests; several have three-minute budgets and create files/commits outside permitted paths.
- Symbol-name matching across aliases/reexports/dynamic use was not exhaustively reviewed.
