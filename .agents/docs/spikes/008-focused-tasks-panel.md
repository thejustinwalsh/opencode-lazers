# 008 — Focused Tasks panel, first pass

Question: Can real persisted task specifications be inspected in a focused native
OpenCode Desktop panel, through the same project-bound read contract available
to agent tools?

Increment: Retain the first read-service and panel implementation. On 2026-10-31,
the user approved the direction as reasonable and requested wrap-up, with further
improvements alongside the durable runner bound to Architect. This closes the
first pass; it does not assert every original acceptance gate is satisfied.

Scope: Starting HEAD `b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df` is an empty initial
commit; the actual source baseline was an untracked working tree captured before
implementation. Architect specified the increment in native Desktop using
GPT-6.1 Sol High: task `2d955ffa-8b58-48c7-b34b-494b2af0d7fc`, revision 1,
session `ses_e6f4c43aeffeIl3rnBXgpq5Cbe`. The [original envelope](../evidence/008-task-panel/task.json)
is retained unchanged. No scheduler, execution, task mutation, or dependency
schema was implemented.

Execution: One implementation worker, plus the user's explicitly requested
GPT-6.1 Terra High read-only review of both images and source. That review used
a Codex subagent; Architect specification and UI verification used native
OpenCode Desktop. No model session was driven through a CLI/service prompt.
Concurrent WebGPU work was preserved; shared GUI/server entry edits are additive.

Budget: The original task records 64,000 tokens, $60 estimated equivalent cost,
360 minutes, 260 tool calls, one provider retry and one repair. Those limits are
stored requirements, not runtime-enforced counters. Complete cross-turn usage
and elapsed accounting were not captured, so budget compliance and equivalent
cost are not claimed. No paid OpenRouter verification was used.

## Retained behavior

- `src/tasks/contract.ts`, `read.ts` and `rpc.ts` share strict query/get contracts
  between GUI RPC and task tools. Queries are bound to the repository's canonical
  project, with literal search, optional submitting-session and scope-path
  filters, limits of 1–100, bounded match snippets, snapshot counts and keyset
  cursors. Detail returns the unchanged stored envelope or explicit absence /
  unsupported revision. Search finds candidates; it does not prove uniqueness
  or resolve semantic overlap.
- SQLite insert row IDs provide the durable watermark for this immutable slice.
  After-commit notifications and one-second watermark polling handle separate
  connections; GUI snapshot resync/polling repairs missed invalidations. Listener
  failure cannot invalidate a committed submission receipt. No event is an
  execution-state transition.
- The Solid panel resolves its routed session's live server/location client.
  Default scope is the original submitting session; Project explicitly includes
  other sessions in that canonical project. No global feed or default-service
  fallback is introduced. Selection/search/split/scroll preferences are session
  scoped; controller cancellation rejects obsolete responses and events.
- Tasks is an optional extra-panel entry and a closable native tab, with a quiet
  scope menu and header search. Sparse lists have a compact initial height; the
  separator is resizable. Rows show a submitted glyph and a bounded objective
  excerpt, without fabricated feature groups or execution states.
- The inspector has a short reference, bounded heading, expandable objective,
  visible Done when checklist with three previews and Show all, and initially
  collapsed Details / Activity. Native Markdown renders descriptive content;
  native Code renders commands and JSON. Full specification starts collapsed and
  scrolls independently within `min(24rem, 45vh)`, with native copy support.
- UI typography is inherited; identifiers use the reactive host monospace font.
  Colors use host semantic tokens, including a theme-relative selected-row blend.
  The approved [mockup](../../../design/task-panel/tasks-focus-v2.png),
  [visual contract](../../../design/task-panel/visual-contract.md),
  [before](../../../design/task-panel/current-panel.png),
  [after](../../../design/task-panel/panel-after-review.png), and
  [JSON capture](../../../design/task-panel/full-specification.png) are retained.

## Verification and acceptance boundary

| Check                    | Observed outcome                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun test`               | 44 tests / 260 assertions pass, including concurrent WebGPU tests                                                                                            |
| `bun lint` / `bun check` | Pass: 56 linted / 52 typechecked files                                                                                                                       |
| Focused formatting       | Task sources, visual contract and handoff pass                                                                                                               |
| `bun run verify`         | Stops at formatting in concurrently edited `.agents/docs/webgpu-api.md`; left untouched                                                                      |
| `bun run build:gui`      | Pass; existing ONNX CJS `import.meta` and Vite deprecation warnings remain                                                                                   |
| Native Desktop           | Real submitted record shown; optional launcher, close → launcher → reopen, compact search, disclosures, JSON highlighting and independent scrolling verified |
| Terra review             | Actual capture compared with approved v2; corrected sparse-list space, control size, unbounded prose and weak selection contrast                             |
| User review              | Direction accepted as a reasonable first pass; further refinement expected with runner development                                                           |

Behavior tests cover older-than-100 records, literal/Unicode filters, project and
session partitions, snapshot pagination during inserts, fresh-process persistence,
notification failure, separate connections, stale recovery, late-scope responses,
event races, stream cleanup and task-tool permission assertions. These tests do
not substitute for the outstanding native gates below.

The [boundary inventory](../evidence/008-task-panel/first-pass-inventory.json)
records baseline/final hashes and concurrent working-tree differences. It does
not attribute other sessions' changes to this pass. Source is still untracked;
no commit, PR, or isolated source revision was created.

Packaging correction beyond the original write list: the project loader now
links `gui-experimental.cjs` to the single built bundle. Global installation
uses that same loader directory, avoiding duplicate `lazers` IDs from global
package and project auto-discovery. A private backup of the previous global
configuration was retained. No second package or GUI entry was added.

## Deferred gates and next increment

Architect's normal permissions and definition remain unchanged. Query/get tools
expose typed Code Mode output, but normal `execute`/query authority was **not**
enabled: native nested-executor confinement and overlap trials have not run.
The prepared `/private/tmp/lazers-tasks-desktop` candidate is an isolated test
fixture, not a production dependency or accepted result.

Native A→B→A continuity, cross-project/server routing, live independent-process
invalidation, isolated host restart/reconnect, named-theme/light/dark/mono-font
matrix and WebGPU-enabled Desktop coexistence are not claimed complete. The
original task's complete acceptance remains unresolved; its durable status is
still `submitted`, with no invented runtime acceptance event.

Have Architect specify the next bounded increment toward the actual durable
runner: validated admission/attempt state, real worker dispatch, persisted
completion/failure evidence and durable delivery back to Architect for decisions.
Keep state transitions and execution policy in deterministic runtime code. Use
the existing task contract and observed failure cases; do not add handoff-only
or proposal-only substitutes. Submission retry identity remains a distinct,
already specified gap to account for at the execution boundary.

Improve this panel as those facts become available: real concise authored task
titles, dependency / Waiting on data, task grouping, lifecycle state and evidence.
The v1 schema stores none of the dependency/runner fields, so this pass does not
invent them. Carry the deferred read/permission/Desktop gates into subsequent
acceptance explicitly rather than treating this first-pass approval as proof.
