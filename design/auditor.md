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

Pinned production dependency: `@fallow-cli/fallow-node` 3.41.0, including its
platform-specific native optional dependency. The library loads only when
`lz-fallow-report` runs. Async native calls run on the server; scans run
sequentially with one analysis thread by default, configurable per call. There
is no renderer scan, daemon, recurring timer or local inference model.

The task SQLite database stores each run and its complete native report sections,
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
