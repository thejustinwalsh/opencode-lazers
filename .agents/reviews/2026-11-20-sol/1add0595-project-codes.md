# 1add0595 — project-codes

## Findings

### 1add0595-1 — major / confirmed

- **Where:** `src/projects/registry.ts:17,152-163`; `src/projects/scope.ts:11` (added later by `a963208e`).
- **What:** Code mutation accepts unlimited trailing digits, while read contracts impose shorter bounds. A successful owner edit can make subsequent reads fail validation.
- **Failure scenario:** Save code `AB12345` (seven characters). The edit succeeds, but an all-projects response's `ProjectRef` rejects its code at max six. With a sufficiently longer suffix, even task-reference validation fails.
- **Evidence:** `CODE_PATTERN = /^[A-Z]{2,4}\d*$/`; setter checks only that pattern/current uniqueness. `ProjectRef.code` has `.max(6)`; task references also have a bounded string schema. No cross-contract test covers long numeric suffixes.
- **Suggested fix / test:** Use one compatible code/reference representation throughout; prevent invalid persisted values without imposing arbitrary data-reading ceilings. Test a successful numbered-code edit through all project/task read schemas, including a suffix longer than six total characters.

## Checked and sound

- Reference sequence allocation spans registered checkouts under the same key.
- Migration preserves dominant-project LZ references and installs project-local legacy aliases.
- Title construction uses stored code rather than recomputing it from a renamed folder.

## Not reviewed

- No migration on live storage or independent-clone concurrency test.
- Historical alias collisions after repeated code reuse were not fully exercised.
