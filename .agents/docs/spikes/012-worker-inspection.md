# Spike 012 — read-only worker trajectory

## Task record

- **Question:** Can Architect inspect visible worker trajectory and total task effort across failed work and retries without exporting private reasoning or credentials?
- **Increment:** Add the read-only `lazers_inspect_trajectory` tool for project-owned task or attempt IDs, returning structured JSON with bounded continuation pages.
- **Starting revision:** Task provenance records `28c4e67f0585d3892e64c1538bb2f8cb920092fe`. The inspected checkout was `abd56bbd7ec0650e8633db4ea5871540ff8f8bcf`.
- **Write scope:** `src/trajectory/**`, `test/trajectory/**`, `src/index.ts`, `src/architect.md`, `src/architect.test.ts`, `README.md`, and this spike's evidence files.
- **Exclusions:** Desktop UI, file export, new pricing/telemetry, model ranking, lifecycle changes, backlog execution, and fallback.
- **Execution selection:** `openai/gpt-6-luna`, variant `max`; Architect on Sol High; no model fallback. The task record identifies plan `7d903c35-5a45-4d2d-a321-e6ffb91faa0a`.

## Original brief (verbatim)

```text
Build a read-only way to inspect a LAZERS worker attempt’s visible trajectory and token usage, so we can judge implementation quality and compare models by total work to an accepted result. Include failures and retries, distinguish cached input and reasoning, and report unknown cost honestly. Keep private reasoning and credentials out of exports. Reuse the existing runner records and OpenCode APIs. Use the task guidance format described in .agents/docs/task-authoring.md and preserve the original brief. Submit and execute the smallest coherent plan with workerModel openai/gpt-6-luna, variant max; you remain Architect on Sol High. No model fallback.
```

## Answers (verbatim)

```text
tool + JSON only; recorded costs only; redacted visible content with acknowledged arbitrary-secret detection limits. Supplement runner task 94298112-1c6c-44ba-87f6-a06533eafa59, not its full backlog.
```

## Result and design

The Architect-only tool resolves task and attempt records from the project-owned
runner store, then reads only worker session IDs found in those records. It checks
the native session's project identity before requesting `session.context`. It
opens the existing project database in SQLite read-only mode without migrations
or runner DDL. It does not call `detail()` or `audit()`, which can write audit
records. The JSON report includes task specification, plan and attempt states,
commits, checks, visible events, model attribution, categorized usage, retries,
recorded worker costs, coverage, and privacy warnings. Task reports retain
unsuccessful attempts; unique worker sessions contribute one cumulative token
snapshot each.

Visible strings and nested tool values are redacted before truncation. Reasoning,
system/skill instructions, attachments, native/replay/metadata fields, and raw
response bodies are omitted; unknown message/content parts fail closed. Common
credential formats, credential-bearing URLs, and sensitive nested key names are
redacted. Arbitrary secrets in prose may evade pattern detection. Costs retain
the legacy worker-attempt scope and provenance; the API-equivalent cost remains
unknown rather than treating subscription zero as an estimate.

The pinned plugin context supplies `session.get` and `session.context`, but not
`client.message.list` (`node_modules/@opencode/plugin/dist/effect/session.d.ts`,
`SessionDomain`). Consequently the report describes returned context coverage,
compaction and missing sessions without claiming complete transcript history.
Comparing model quality or efficiency still requires matched tasks with the same
starting code, tools, acceptance, and review; this single increment is not a
model comparison.

## Verification

- `bun test src/trajectory test/trajectory` — 14 passed, 0 failed, 102 assertions.
- `bun test` — 134 passed, 0 failed, 986 assertions.
- `bun run verify` — formatting, lint, and typecheck passed.

Tests cover permission-before-access, the Architect-only gate, owned session
identity, registered JSON output and page order, stale/foreign continuations,
failed-to-accepted attempts and checks, retry accounting, categorized usage,
unknown costs, redaction of object and serialized-JSON secrets before truncation,
excluded and unknown content, native errors, rejected SQL mutations, read-state
invariants, and callback use after registration disposal.

## Unresolved native evidence

A fresh production-adapter read of retained attempt
`3ceef8dc-c679-4eb7-b1fe-04cc0951f672` was **not performed**. This execution is
the implementor; the registered tool explicitly requires `call.agent ===
"architect"`, and no Architect-authorized invocation was available here. No
usage, verifier-check, retained-session, or live API-coverage observations are
claimed. The limitation and the required next action are recorded in
[`native-report.json`](../evidence/012-worker-inspection/native-report.json).
This evidence remains unresolved until an Architect-authorized production read
is completed.

## Driver review and native observation

The Desktop Architect subsequently read current attempt
`e3d41c7b-55fa-43ee-b198-3483230dd92f` and its task through the registered tool.
Both succeeded; the admitted and observed worker model is OpenAI GPT-6 Luna Max.
Returned coverage explicitly reports compaction and does not promise complete
history. See [native report](../evidence/012-worker-inspection/native-report-current.json).

The older retained attempt remains rejected: its immutable task project ID is
`global`, while the current native project has a Git-backed ID. Project isolation
was preserved. This limits historical coverage; it is not a successful read of
that legacy attempt.

Driver review exposed missing advisory guidance in the task projection and
credential patterns missed in visible prose (OpenCode keys and embedded quoted
JSON). Regressions failed before the fixes and pass afterward. Current focused
suite: 15 tests / 108 assertions. Full suite: 135 tests / 992 assertions.
Formatting, lint and typecheck pass. Native observations above precede these
small review fixes; their regressions establish the corrected projection and
redaction behavior.
