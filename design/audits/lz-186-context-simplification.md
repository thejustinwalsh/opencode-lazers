# LZ-186 scoped audit — repository evidence, guidance, Auditor coherence

Task 8ff17c9d-8e47-4fab-92f2-276378f55de3. Scope: `src/context/**`,
`src/audit/**`, `src/architect.ts`, `src/architect.md`, `src/implementor.md`,
`src/auditor.md`, `src/personas/**`, `test/context/**`. No new feature, layer,
or acceptance gate.

## Audit record (durable, not checkout JSON)

- Baseline run `5a34540f-8f44-41ad-9597-b2cf1de5a86b` (phase baseline).
- Follow-up run `4197548f-3594-4d6b-80e1-733a22261c2b` (phase follow-up,
  baseline linked). Report bytes live outside the worktree in the LAZERS audit
  store; retrieve with `lz-get-audit`. No `design/audits/*.json` copies were
  made per current guidance.
- Scan limitation: Fallow static findings are candidates. Unused-export/file
  signals miss dynamic native plugin entry points (`processor.ts` worker URL,
  agent Markdown `with { type: "text" }` imports, test-only references) and
  the durable audit history committed at `c9ffb96` is newer than this
  worktree baseline (`f62d134`), so `src/audit/**` persistence was preserved
  untouched.

## What changed (net simplification, behavior preserved)

1. `src/context/index.ts`: added `selectPermitted` helper. `manifest` and
   `evidence` shared the snapshot/select/permission sequence; both now call
   one helper with the same abort, isolation, and per-file permission
   semantics. Response shapes, 100/50 limits, and truncation accounting are
   unchanged.
2. `src/context/tools.ts`: added `permittedRead` helper. `lz-project-index`
   and `lz-project-read` shared the permission-assert plus tryPromise
   scaffolding (the only in-scope duplication clone family,
   `dup:b72921e1`); both now use one helper with their own action,
   input, and index call. Architect-only refresh is untouched.

No prompt, permission, schema, or persisted-data change. `packet`,
`processor.ts`, and agent Markdown imports were confirmed live and retained.

## Result

- Duplication: `src/context/tools.ts` clone family resolved. Follow-up shows
  clone groups 174 → 173, instances 379 → 377, duplicated lines 3623 → 3605.
  Scoped query for `src/context/tools.ts` duplication returns zero findings.
- Dead code: `ProjectIndex.packet` unused-class-member finding is a
  false positive (covered by `src/context/index.test.ts` worker-packet case);
  recorded as retained, not deleted. All other dead-code findings are
  out of scope or dynamic-entry misses; left intact.
- Health/complexity: no function splits made; splitting `walk`/`packet`
  would relocate branching without reducing total complexity.
- `src/audit/**`: no edit. Durable `history.ts`/`contract.ts`/`tools.ts`
  from `c9ffb96` remain authoritative; this worktree predates them and must
  not overwrite them.

## Finding dispositions

- `.../duplication/clone_groups/165` → `fixed` (linked to follow-up run).
- `.../deadCode/unused_class_members/0` (`ProjectIndex.packet`) → `retained`.

## Checks

- `bun run verify` (fmt, lint --fix, fmt, check): pass, no type errors.
- `bun test src/context test/context src/architect.test.ts
src/audit/report.test.ts`: 26 pass, 0 fail.
