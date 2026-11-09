# External repository snapshot review — 2026-11-09

LZ-193 candidate `ebd9f0290f483ac68615d59e75da73058deca70b` legitimately composes
the reviewed `0de515a` baseline. Quality and the declared context/native/task
instruction checks pass: **76 tests, 524 assertions**.

Worker-native receipts also show real fetch-and-reread probes for
`octocat/Hello-World` default selection and `yamadashy/repomix` URL-selected
`feat/biome-v2`, each returning useful source plus a complete reusable artifact.
These are observed worker probe results, not new Architect executions.

Independent source review confirms the previous slash-ref, cumulative-retention
and omitted POSIX-filename fixes. Permission-before-fetch, config/trust isolation,
background cancellation/timeout, staged publication and registry/read handling
are coherent in the reviewed paths.

## Remaining defects

- `src/context/repo-processor.ts:101–111` rejects commas even in ordinary brace
  globs such as `src/**/*.{ts,tsx}`. Installed Repomix's pattern utilities already
  preserve brace-expression commas. This is an unnecessary public selection gate.
- `src/context/repo-processor.ts:63–70,163–166` and
  `src/context/repository-snapshots.ts:196–202,236–239` still reject processed
  POSIX backslash filenames and paths longer than 1024 characters, discarding the
  useful pack. These strings are source provenance, not local extraction paths.
  The omission-only fix does not resolve this behavior.

Advice 3 requests one coherent correction with registered-tool selection and
artifact-reread regressions, preserving actual opened-path/output containment and
all previously passing lifecycle safeguards. No new worker, clone subsystem or
unrelated source change is authorized.

Ordinary retained repair was requested for the exact accepted artifact/attempt
and refused before reservation: “Retained repair worker's accepted input is no
longer its completed current turn.” This matches the investigated input-lineage
defect blocking LZ-194. Existing LZ-181 owns the root lifecycle correction; retain
the original worker and retry only through supported controls after correction.

**Integration and cleanup are held.** Acceptance and previous passing checks do
not override these two remaining behavior defects or prove cleanup safety.
