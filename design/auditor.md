# Auditor

Auditor performs behavior-preserving simplification through the existing LAZERS
runner. Architect identifies coherent system boundaries, groups intertwined
changes, submits ordinary tasks and dependency graphs, then reviews each result
before integration. Review can steer/resume the original worker. Findings are
not individual microtasks and analyzer scores are not acceptance gates.

## Registration and route

The native `auditor` agent is a runtime-managed subagent, using the shared worker
instructions plus `src/auditor.md`. Its default route is OpenCode Go
`muse-spark-1.3-contributor`. The live native catalog confirmed that exact route
is enabled, and a quiet `location.reload()` confirmed the effective Auditor model
and Architect guidance. Existing native configuration is preserved. An explicit
plan model remains an override. The three implementor personas are unchanged;
Auditor uses its role's model rather than their implementor mappings.

`workerAgent: "auditor"` is optional on the normal plan schema; existing plans
continue to use `lazers-implementor`. The chosen role is persisted with the
attempt and reused for session creation, continuation, progress hooks, task
activity, shared source context and recovery. No parallel scheduler, persistence
layer, approval service or model caller is introduced.

## Fallow

Fallow runs as committed WebAssembly modules built from vendored Fallow 3.43.2
(`src/audit/wasm/`); no Fallow npm package, native addon or companion binary is a
dependency, development or otherwise. The modules load only when an analysis runs,
in a worker thread, so scans stay off the service event loop. By default a scan
runs on the threaded module with a pool of two threads (plugin option
`fallowThreads: "on" | "off"`, default `"on"`; `"off"` uses the single-threaded
module); if the threaded module is unavailable or traps, that call and every later
one run on the single-threaded module and the reason is logged once. There is no
renderer scan, daemon, recurring timer or local inference model.

Whole-project analyses (up to 12,000 source files) use Fallow's own cache in `<root>/.fallow`,
the only place the module may write; it ignores itself, so `git status` stays clean. A review's
worktrees seed it from the project's canonical checkout and publish back to it.

The task SQLite database stores each run and its complete report sections,
linked to project, task, plan, attempt and session. Worker association comes from
the runtime assignment, not model claims. Start, section capture, finish and
finding decisions carry Unix millisecond timestamps. Each analysis is committed
before the next starts; errors and interrupted runs retain their saved results.
The first scan defaults to baseline; follow-ups link to it. Request identities
make exact tool retries return the existing run without rescanning.

- `lz-fallow-report`: scan and return run ID, summaries and export location.
- `lz-query-audits`: browse project/task/attempt/plan history.
- `lz-get-audit`: page structured findings, filter by analysis/path, optionally
  retrieve original JSON or regenerate its export.
- `lz-record-audit-finding`: append an assessment and rationale, optionally
  linking a follow-up run. Previous decisions remain readable.
- `lz-import-audit`: preserve a legacy report without rerunning analysis;
  imported metadata remains provenance, not inferred worker ownership.

Exploration tools need no durable run: `lz-fallow-dupes`, `lz-fallow-health`
and `lz-fallow-dead-code` page duplication, complexity and dead-code findings
directly against the current worktree, worst first, with no source fragments.
`lz-fallow-config` reads the effective config (repo file, else the stored
LAZERS project config, else defaults) and can propose a draft; only
`lz-fallow-config-set`, which stores a new LAZERS config revision, is denied
to worker agents. `lz-fallow-check` previews the introduced-only review the
runtime runs when an attempt finishes; the Implementor's instance of it is
denied, since that preview is Auditor- and Architect-facing. Findings from
every one of these tools are feedback, never a rejection: only what a change
introduces or worsens is ever reported, and older findings are never counted.

All five tools are available in Code Mode with native permissions. Task details
include a compact history locator. JSON exports live in `audits/<runID>.json`
beside the task database, outside worktrees. SQLite remains authoritative when
an export is missing or cannot be written; exports can be regenerated after
checkout removal. No report write scope or separate audit service is needed.
Reports cover dead code/dependencies, duplication, complexity/CSS health,
architecture and feature flags. Optional model-based similar-code search is not
started; it needs a separate model companion.

Auditor saves before/after reports, confirms actual callers and dynamic entry
points, removes/consolidates/refactors code, runs automatic quality fixes and
relevant behavior checks, then reports the useful simplification and remaining
findings. Added helpers/tests must support the net simplification, not new
features or layers. It may report no safe change. Architect judges behavior and
maintainability, not a zero-finding target or raw line count.

## Sources

- [Fallow native bindings](https://www.fallow.tools/docs/integrations/node-bindings/): async API, reports and platform packages. The real bundled binding is tested under this project's Bun runtime.
- [Fallow analysis](https://www.fallow.tools/docs/analysis/): available static analysis categories.
- [OpenCode Go](https://opencode.ai/docs/console/go/): model availability and provider behavior. The actual connected catalog, rather than a static web list, established the exact configured route.
- [Pinned OpenCode API index](../.agents/docs/opencode-api.md): native agent transforms, runtime session creation, tool registration and location reload.

## Validation

Native Fallow fixture analysis saves all five reports and leaves source intact.
History tests cover native assignment, before/after links, append-only decisions,
partial/interrupted persistence, project isolation, import, DB reopen and export
regeneration after checkout removal. Tool tests exercise all five registrations
and native permission denial. History never establishes task completion.
A runner integration test dispatches Auditor with the selected route and retains
the same attempt while awaiting Architect review. Both worker roles pass the
same native-hook/retained-event coalescing test. Broader integration and runtime
suite results are retained in `.cache/driver/auditor-*.log` and summarized in the
handoff. Effective registration was observed natively; the first system-wide
Auditor refactor remains a dogfood observation, not a result inferred from tests.

## Native observation — 2026-11-08

LZ-186 resumed the original Muse worker after the default-effort adapter repair
and verified Go training permission. The actual worker called `lz-fallow-report`
and then `lz-get-audit` to retrieve dead-code findings. SQLite records baseline
`5a34540f-8f44-41ad-9597-b2cf1de5a86b`, task
`8ff17c9d-8e47-4fab-92f2-276378f55de3`, attempt
`e3f446f8-0969-4af6-b887-714f5095543a`, session
`ses_0a7c388bd25741348a4fcaa75b9f825b`. Start1794170969948,
finish1794170974814 Unix milliseconds:4.866 seconds, completed baseline.
This proves native scanning, automatic association and finding retrieval.
Follow-up comparison, simplification, Architect review and integration remain
unproven until that worker finishes and its result is reviewed.
