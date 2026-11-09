# Tool-call failure audit — 2026-11-09

The largest recorded problem is stale or incorrect patch context: **458 of 778
failed tool calls (58.9%)**. Missing paths and grep input mistakes follow. Invalid
tool-schema arguments account for 31 failures (4.0%). The existing ledger does
**not** establish failure rates for every agent or every Code Mode inner call.

This is an evidence report, before implementation or prompt changes. No models
were prompted, workers interrupted, services restarted, database rows changed,
or source/guidance files edited during this audit.

## Scope and counting

- Database: `~/.local/share/opencode/plugins/lazers/tasks.sqlite`, opened with
  SQLite URI `mode=ro`, `PRAGMA query_only=ON`, and bounded read transactions.
- Final aggregate snapshot: **2026-11-09 01:37:33 UTC**; maximum observed progress
  sequence `18775360`. Tool-row `at` range: **1793452369712–1794188248464 Unix
  milliseconds** (2026-10-31 13:12:49.712 through 2026-11-09 01:37:28.464 UTC).
- **28,527 `kind='tool'` rows**, across 177 assigned worker sessions:
  27,744 succeeded, 778 failed, and 5 not-executed. Failures affect 136 sessions.
  The observed failed-row fraction is **2.73%**; it is not a whole-product rate.
- There are **zero duplicate `(session_id, call_id)` identities** among these
  tool rows. Native events, hooks, and retained-message reconstruction merge into
  the same call key. A retried call has a new identity and counts separately.
- Calls also occur in `kind='commentary'`: 623 rows carry a tool identity,
  including 516 named `execute`. None have `status='failed'`. They are excluded
  from the tool-row denominator above; this classification is another reason
  not to present that denominator as all native calls.
- The service remained active, so earlier intermediate denominators were lower;
  the 778 failed identities and reason counts stayed unchanged during the audit.
- Error excerpts below omit user paths, source bodies, URLs, and raw arguments.

## Ranked observed reasons

Buckets are mutually exclusive, based on the retained public error message.
They describe observed symptoms, not an automatic blame assignment.

| Rank | Reason                             | Calls | Sessions | Interpretation / sanitized example                                                                                                                                                                                   |
| ---- | ---------------------------------- | ----: | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Patch context mismatch             |   458 |      104 | `patch verification failed: Failed to find expected lines in src/runner/runtime.ts`. Usually stale context, wrong file state, or an inaccurate hunk; not a schema failure.                                           |
| 2    | Missing read path                  |   101 |       64 | `File not found: src/trajectory/fixture.ts`. Guessed, moved, generated, or unavailable paths; absence alone is not a product bug.                                                                                    |
| 3    | Missing grep path                  |    70 |       37 | `Search path does not exist: src test`. Includes passing several paths or shell glob/brace syntax as one literal path.                                                                                               |
| 4    | Cancellation / interruption        |    33 |       24 | Location shutdown (21), interrupted tool execution (9), web-search cancellation (3). Expected lifecycle outcomes unless the cancellation itself was unintended.                                                      |
| 5    | Schema validation                  |    31 |       24 | Shell missing `command` (23), execute missing `code` (5), patch missing `patchText` (2), webfetch `format: "json"` (1; accepts text/markdown/html).                                                                  |
| 6    | Read offset past EOF               |    25 |       23 | `Offset 256 is out of range for this file (255 lines)`. Includes off-by-one pagination and stale file-length assumptions.                                                                                            |
| 7    | Invalid grep regex                 |    24 |       13 | `Invalid regex pattern: rg: regex parse error`. Often literal source punctuation treated as regex.                                                                                                                   |
| 8    | Other patch syntax / file failures |    10 |        9 | Missing `*** End Patch` (5), malformed/empty hunks (3), update target absent (2).                                                                                                                                    |
| 9    | Role / assignment guards           |    10 |        3 | `Implementor requires an admitted runtime assignment` (9); `Plan orchestration is restricted to Architect` (1). Expected policy enforcement; investigate orchestration only if the call was supposed to be admitted. |
| 10   | Web resource 404                   |     6 |        2 | Non-2xx 404 responses. Remote absence, not evidence of a LAZERS defect.                                                                                                                                              |
| 11   | Unknown tool names                 |     3 |        1 | `lazers_get_task`, `review_get09`, `manage_laz103` unavailable. Historical names/catalog guessing.                                                                                                                   |
| 12   | Suggested skill unavailable        |     3 |        3 | `Unable to load skill portless-dev-servers`. Existing implementor guidance already says optional unavailable skills do not block work. Repository-required server routing still applies before a server launch.      |
| 13   | Other individual outcomes          |     4 |        4 | Unterminated shell quote, plan not found, provider response ended unexpectedly, working directory absent. Each occurred once.                                                                                        |

By native tool name: patch **481**, read **131**, grep **96**, shell **33**,
execute **18**, webfetch **7**, websearch **3**, skill **3**; one each for
question, lazers_get_task, review_get09, manage_laz103, lazers_inspect_plan, and
lz-record-architect-continuity. Native tool names and aliases changed over the
period; these names are reported as stored.

Patch context mismatches span 2026-10-31 13:26:47.077 through 2026-11-09
01:01:27.172 UTC. Schema validation spans 2026-10-31 18:08:01.078 through
2026-11-07 21:54:43.876 UTC. Missing reads and grep paths recur across most of
the period, rather than one isolated bad turn.

| UTC day             | Failed tool rows | Tool rows |
| ------------------- | ---------------: | --------: |
| 2026-10-31          |               84 |     2,037 |
| 2026-11-01          |              127 |     3,886 |
| 2026-11-02          |               81 |     3,444 |
| 2026-11-03          |               46 |     2,040 |
| 2026-11-04          |               65 |     2,554 |
| 2026-11-05          |              125 |     5,320 |
| 2026-11-06          |              132 |     5,051 |
| 2026-11-07          |               69 |     2,316 |
| 2026-11-08          |               33 |     1,396 |
| 2026-11-09, partial |               16 |       483 |

Joining failures to the same session/message's recorded step identifies
`lazers-implementor` for **598**, `auditor` for **1**, and leaves **179 unknown**.
The ledger's tool payload does not consistently preserve the hook's agent.
Missing step attribution must not be silently filled from a session's current
agent or assigned task persona. No Architect/researcher rate follows from this
worker-only sample.

The next recorded call of the same tool in the same session succeeded for
**675/778** failures; **653** had that success within five minutes. Another 84
were followed by a failure, and 19 had no later same-tool call. This is a recovery
proxy, not proof the same intent succeeded: parallel calls and unrelated later
operations can share a tool name. Examples: patch sequences **112→116** (23.9 s)
and **118→122** (18.0 s), and grep **368→372** (16.1 s).

## Product / infrastructure signals separate from argument mistakes

Five additional error-bearing calls are stored as **not-executed**, rather than
failed: patch, shell, read, execute, and question, sequences
**18740503/504/506/508/510**, on 2026-11-05 15:01:24–15:02:30 UTC. Each carries
`database or disk is full`. These are infrastructure failures worth preserving
in the user-visible error count; the message does not establish which store or
resource was full. Do not reinterpret them as model argument mistakes or
successful calls.

The single provider-ended response is a provider/output failure. The ten role
guards are expected product enforcement, not ten proven permission bugs. No
explicit native `permission.denied` error appears in the 778 failed rows; missing
coverage prevents concluding that permission failures never occurred elsewhere.

## What the existing capture actually guarantees

1. `src/progress/native.ts` registers `execute.before`, `execute.after`, and
   native tool input/called/success/failed event subscriptions. After-hook writes
   use the shared recorder; errors are privacy-filtered. Registration is not the
   same as every-agent persistence.
2. `src/progress/recorder.ts:1341` drops after-hook calls unless the agent is
   `lazers-implementor` or `auditor`, and excludes `lz-report-progress`.
   `appendForSession` then requires an existing runner-attempt assignment.
   Native events and retained-message recovery also require that assignment.
   Architect, research specialists, and ordinary/unassigned agent sessions
   therefore lack this durable per-call ledger coverage.
3. The before-hook records only supported bounded file targets for
   `lazers-implementor` during an active assigned attempt. It is not a general
   all-tool input/failure observer and does not capture auditor file targets.
4. **667/778** failures include after-hook evidence; **111** do not. Native or
   retained data recovers some calls without a hook. **30/31 schema-validation
   failures include hook evidence**; the earliest execute example is retained
   recovery only. Thus invalid arguments cannot be assumed to bypass the
   after-hook universally. The installed type declarations describe error
   after-hooks but do not prove precise validation/before-hook ordering.
   Upstream source was unavailable during this audit; no ordering guarantee is
   inferred from that absence.
5. All rows have integer Unix-millisecond `at`, but this can be observation or
   retained-message time. **645/778** failures have an explicit tool completion
   endpoint and input endpoint; 643 have a called endpoint. **133** lack the
   tool completion endpoint. Do not relabel row `at` or `recorded_at` as an exact
   execution boundary. Hooks currently use `Date.now()` without recording a
   separate hook observation in the tool timing endpoints.
6. Recovery has a 10,000-message bound and explicitly records gaps: public
   retained context is not guaranteed complete; compaction or lost events can
   omit history. Existing native-log replay only establishes current idle
   lineage, not replay of all tool history. See
   [the native-log boundary review](native-log-replay-boundary-20261107.md).

## Code Mode: concrete missing identity

A bounded read-only `message.list` request against the existing service observed:

- Worker session `ses_5ca737288c6945eea2e21644eaea05d2`, message
  `msg_1bdef9cad001hOj5ncKoR5Sbyw`, outer call
  `call_4f95ef0af094438999f55b286990201c`: its execute code invoked
  `tools["lz-get-task"]`. The native message lists only outer `execute`.
  Durable sequence **18775234** likewise records only `execute`; there is no
  separately identifiable `lz-get-task` row for this call.
- The same session's `msg_1bdf1cb44001Q9orMXST4JVyNA` invoked
  `tools["lz-report-progress"]` inside execute. Durable **18775273** is a
  commentary/tool aggregate with tool name `execute`, using the **outer** call
  ID `call_d8a18aa44fe7472b9dec9b490833b869`. Its provenance includes
  tool-commentary, tool-hook, native events, and recovery. This demonstrates
  shared call identity, not a distinct nested invocation identity.
- The current key `tool:${sessionID}:${callID}` has no nested invocation
  discriminator. The present data cannot count failures caught by execute code
  independently of outer success, or establish that every inner invocation has
  its own durable row. Native hook ordering/inner delivery remains unproven.
- Code Mode `fetch` is an extension outside native tool hooks, already documented
  in `src/runner/roles.ts:125` and the
  [retained-work bootstrap review](retained-work-bootstrap-repairs-20261105.md).
  Its permission evaluation is not a terminal success/failure observation.

Do not manufacture child call IDs, parse arbitrary user code into invocation
facts, monkeypatch the host, or claim historical nested coverage. Tool failures
inside a successful outer execute remain a separate coverage question.

## Minimal proposed changes, pending review

1. Add a few concrete reminders to project-owned `src/implementor.md` (also used
   by Auditor): discover actual paths; native grep takes one path and regex, not
   a shell path list; reread exact current context before retrying a failed
   patch; stop pagination at EOF; execute takes JavaScript in `code`, while shell
   takes `command`. Keep examples short and match the native catalog. Preserve
   current tool capabilities, permissions, and limits. Do not duplicate full
   native descriptions. Architect may receive the same short argument reminder
   in `src/architect.md`, although this sample cannot estimate its error rate.
2. Preserve role/assignment guards. For telemetry, accept actual hook agent and
   session identity independently of runner assignment. Reuse canonical safe
   error projection, persistence, provenance, and deduplication. Existing
   runner-progress rows require non-null plan/task/attempt associations; simply
   deleting `isWorkerAgent` cannot capture other sessions. Represent absent
   associations explicitly rather than inventing runner IDs or attaching calls
   to an unrelated task. Keep this change within the existing persistence layer.
3. Preserve every observed hook failure and error-bearing not-executed outcome,
   including schema/permission/guard errors. Record hook observation Unix
   milliseconds separately from host execution timestamps, and persist the
   actual observed agent. A recording failure must not change native execution.
4. Check the installed native Code Mode dispatch contract before implementing
   child capture. Use a real native child identity if available. If native hooks
   are insufficient, instrument only project-owned tool registrations, with one
   shared recorder and a truthful locally observed invocation identity. Preserve
   repeated same-tool invocations; avoid counting the same hook/wrapper call
   twice. Keep parent/child uncertainty explicit if native identity is absent.
   Native `fetch` cannot acquire terminal coverage from a tool hook alone.
5. Verify assigned implementor, assigned auditor, Architect, researcher, and
   unassigned-agent error paths; schema failures and guard failures; privacy;
   Unix time provenance; native/recovery dedupe; and Code Mode inner failure with
   outer success, repeated inner calls, and outer failure. A mocked outer hook
   is not evidence of native nested delivery. Use supported read-only existing
   host observations or isolated deterministic tool calls without model prompts
   for that boundary. Do not interrupt existing parallel workers.

Examples for regression fixtures: sequences **112** (patch mismatch), **38**
(read EOF), **367/388** (grep literal path lists), **1554/4138979** (execute uses
`command` instead of `code`), **376919** (empty shell arguments), **18737650**
(webfetch format), and **18740503** (error-bearing not-executed). Source errors
must be sanitized in fixtures; do not copy raw payloads or reasoning.

## Authorized repair and verification

The follow-up repair adds `native_tool_calls` in the existing database, without
rebuilding runner/recovery tables. It is the canonical call ledger going forward;
assigned worker progress is its existing task-facing projection. Its actual
observed agent, nullable plan/task/attempt links, hook-observation Unix
milliseconds, native endpoints, and source provenance remain distinct. Matching
native observations and hooks merge into one native call identity. Stable hook
observation identities keep duplicate delivery and replay inert.

Native hook/event capture now accepts every agent, including unassigned sessions,
after checking actual native project and location ownership. Session movement
invalidates that ownership cache. Lookup or recording failures cannot reject,
retry, or replace the original tool call. There is no new polling loop.

An observational transform wraps project-owned `lz-` callbacks. It preserves
their schemas, options, receiver, arguments, result, errors, defects and
interruption. When an observed outer `execute` supplies the shared native
context, each callback invocation receives a distinct **local invocation UUID**
and stores the real outer call ID separately. No UUID is called a native child
ID. A context without that evidence remains unresolved; a later matching native
tool observation can resolve a direct call without duplicating its wrapper row.
Concurrent repeated callbacks remain distinct. Replayed transforms unwrap their
previous observation wrapper before installing the replacement.

`src/implementor.md`, also used by Auditor, now contains the short path, grep,
patch, EOF and execute-versus-shell guidance supported by the audit. No Architect
prompt, execution permission, model setting, task scheduling, or inference
behavior changed.

Verification: **116 tests pass, 0 fail, 1,209 assertions** across
`src/progress/tool-calls.test.ts`, `src/progress/native.test.ts`,
`src/progress/recorder.test.ts`, `src/runner/store.test.ts`,
`src/runner/roles.test.ts`, and `src/recovery/producer.test.ts`.
`bun run verify` passes formatting, automatic lint fixes, formatting again and
typechecking, with no remaining lint warning. `git diff --check` passes.

This repair was not activated with a service reload or a model prompt during
verification. Existing parallel workers and the production database were not
mutated by this repair's tests.

Remaining native boundaries are explicit: native/third-party Code Mode inner
calls and the fetch extension are not project-owned callbacks. Inner validation
or permission rejection before entering a callback also cannot acquire a local
callback identity. If execute code catches these errors, an outer successful
call does not prove inner success. Precise installed-host hook ordering and
native child-identity delivery remain unproven; the repair makes no claim of
independent capture for those unsupported cases. Error-shaped domain results
returned successfully by a tool are likewise not automatically reclassified as
thrown tool errors.

Historical rows keep their original coverage. There is no bulk historical
backfill or invented agent/timestamp. Existing bounded retained-message
reconciliation may enrich canonical records with truthful recovery provenance.
For future audits, read canonical records first and only use a bounded legacy
worker tail when the native call is absent from canonical history. For example,
with `:directory` bound to the canonical project directory:

```sql
WITH legacy AS (
  SELECT * FROM runner_progress
  WHERE project_directory=:directory
    AND kind IN ('tool','commentary') AND call_id IS NOT NULL
    AND json_type(payload,'$.tool')='text'
  ORDER BY seq DESC LIMIT 10000
)
SELECT 'canonical' AS coverage, session_id, identity_kind, invocation_id,
       native_call_id, parent_call_id, agent, first_observed_at AS observed_at,
       json_extract(payload,'$.tool') AS tool,
       json_extract(payload,'$.status') AS status,
       json_extract(payload,'$.error.message') AS error
FROM native_tool_calls WHERE project_directory=:directory
UNION ALL
SELECT 'legacy-worker', p.session_id, 'native-call', p.call_id,
       p.call_id, NULL, json_extract(p.payload,'$.agent'), p.recorded_at,
       json_extract(p.payload,'$.tool'), json_extract(p.payload,'$.status'),
       json_extract(p.payload,'$.error.message')
FROM legacy p
WHERE NOT EXISTS (
  SELECT 1 FROM native_tool_calls c
  WHERE c.project_directory=p.project_directory AND c.session_id=p.session_id
    AND c.identity_kind='native-call' AND c.native_call_id=p.call_id
);
```

The legacy tail is intentionally bounded and worker-only; it cannot establish a
whole-product historical rate. Analyze native calls and local callback
invocations separately rather than summing parent and child counts as though
they were the same measurement.

## Subsequent native observation

After the repair was committed, Driver inspected the production DB read-only.
The ledger already contained actual hook/native records for `architect`,
`general`, and assigned `lazers-implementor` sessions. Architect calls had null
attempt links; worker calls retained their actual attempt IDs. For example,
`lz-query-tasks` had a separate local-invocation row linked to outer execute
`call_45d5c017966e4994b5110ad7542f5e5a`, with Unix observations
1794188753185–1794188753198. `lz-verify-task` similarly linked to
`call_ebe83023688e48d5a4a9066edb2b7cec`. General shell and worker read/patch
records carried hook/native provenance. These are real successful invocations,
not isolated test fixtures. No role-attributed failed row was present in this
bounded observation, so native failure capture remains unobserved live.

This demonstrates that the source is effective in at least those loaded
locations; it does not prove a coordinated reload of every historical worktree,
nor coverage of the unsupported inner-call boundaries described above. Null-agent
retained recovery rows remain null rather than being assigned an invented role.
