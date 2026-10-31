# Spike 007 — retry-safe task submission

## Question and increment

Can a caller recover the original submitted receipt after an ambiguous response or
host restart without duplicate tasks, using an explicit durable repository-scoped
key? Retain one submission-only increment: required transport key, structural
proposal comparison, atomic SQLite association, and native-tool replay/conflict.
Submission does not execute work.

## Scope and provenance

- Task: `5f5743c3-1bd0-4a53-a86b-a347dd961e1a`, revision 1.
- Assigned worktree starting HEAD: `1b03c03423ac4e0bd1082018c897ebd36da70755`.
  Six preserved task edits were already present in storage, submission, schema,
  tool and fixture files. Earlier continuation inspected `e42196b`; the task's
  historical observation `b5da4ca` is not this implementation's starting tree.
- Result artifact: the commit containing this spike record. Reproduce the scoped
  implementation diff with `git diff 1b03c03423ac4e0bd1082018c897ebd36da70755 <result-commit>`.
- Implementation diff SHA-256 (excluding this record):
  `228dbc6b1c77304137c72eca1bf45830276698a32440b87f2c5392cd285deb7c`.
  At the resulting commit, reproduce with
  `git diff 1b03c03423ac4e0bd1082018c897ebd36da70755 HEAD -- . ':(exclude).agents/docs/spikes/007-retry-safe-submission.md' | shasum -a 256`.
- Writes limited to the task's submission/storage/schema/tool sources and tests,
  `test/proposal.ts`, `test/retry-process.ts`, Architect prose, README and this file.
  Existing runner/GUI/permission rules, dependency pins and unrelated edits remain
  untouched. The baseline already includes version-2/3 migrations and the key table;
  this increment completes their guarantees rather than replacing that schema.
- One implementation worker (GPT-6.1 Sol), normal repository tools and Bun. No
  delegation, listening server, provider/model evaluation or paid call. OpenCode
  skill and pinned V2 API reference consulted. Runtime policy owns accounting;
  actual model usage/equivalent cost is not available to this worker.

## Acceptance and implementation

- The top-level key is required, exact and bounded (1–200 UTF-16 code units with
  non-whitespace text), separate from legacy stored proposals/envelopes. Native
  permission checks precede all database access; validation precedes provenance.
- One immediate SQLite transaction covers key lookup, lazy provenance collection,
  task insertion and association insertion. The existing primary key and foreign
  key enforce uniqueness and prevent dangling associations. Observers run only
  after a successful keyed commit, not on rollback/replay.
- Concurrent first opens exposed SQLite's immediate `SQLITE_BUSY` during WAL
  configuration despite its busy timeout. Connection configuration now retries
  only that busy result for up to five seconds; task writes are never replayed.
  Unsupported future versions are checked before WAL changes and again under the
  migration lock.
- Full validated proposal structure, not hash equality alone, defines a match.
  Replays return the original receipt and preserve the original stored body.
  Conflicts return a stable structured outcome with no stored content disclosure.
- Tests exercise lost receipts, nested object reordering, significant array/value
  changes, exact keys, project isolation, changed session/worktree and inaccessible
  Git on retry, barrier-released independent process races (matching and conflicting
  payloads), injected association failure, provenance failure, SQLite constraints,
  genuine v1 migration/reopening and migration rollback, future-version rejection,
  and permission denial before first/replay/conflict/read paths.
- The one-shot child reconstructs the registered native tools against the same
  file-backed database. The first child deliberately emits no receipt; a fresh
  child retries and uses native get/list to observe the unchanged task. No Desktop
  UI/model verification is claimed or required for this deterministic boundary.

## Verification and outcome

Verified with Bun `1.4.4-canary.1+da867c60b` and the existing pinned dependencies
installed using `bun install --frozen-lockfile` (no lockfile/dependency edits).

| Command                                                                 | Result                                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `bun test src/task.test.ts`                                             | 8 passed, 0 failed; 70 assertions                                          |
| `bun test src/storage.test.ts src/tools.test.ts src/submission.test.ts` | 24 passed, 0 failed; 191 assertions                                        |
| `bun test`                                                              | 105 passed across 28 files, 0 failed; 720 assertions, 17.66 seconds        |
| `bun run verify`                                                        | Formatting: all 163 files; lint: 94 files clean; typecheck: 89 files clean |
| `bun test src/submission.test.ts` (ten consecutive runs after repair)   | Each run: 9 passed, 0 failed; 86 assertions                                |
| `git diff --check`                                                      | Passed                                                                     |

The initial full boundary found fixture typing errors and intermittent contention
in the first WAL transition. One bounded repair corrected literal/receipt fixture
types, stopped race cleanup from hiding child diagnostics, and added the narrowly
scoped WAL-configuration busy retry. All listed final checks passed after repair.
Later implementation edits invalidate the affected results.

**Outcome: retain.** Durable replay, conflict/isolation, atomicity and migration
are established at the tested native-tool/SQLite boundary. No known unresolved
implementation issues. Model usage and equivalent cost are unavailable to the
worker. Desktop UI/model interaction remains unperformed, not substituted by CLI
prompts; no Desktop-evaluation claim is made. No retention/expiration policy,
automatic submission retries, execution or permission expansion is included.
