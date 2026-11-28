# Task code review inside OpenCode

Status: foundations and portable producer packaging are integrated at `ef4f2854`. The Review consumer UI and shared branch/PR integration below remain implementation work. The native Architect owns tasking and integration; an external Opus lane implements the UI.

LAZERS baseline: `fb60d25b`. Oaink is available at `/Users/tjw/Developer/oaink`, remote `git@github.com:thejustinwalsh/oaink`, HEAD `020c70b`. Its working tree contains substantial uncommitted changes. This review includes those current files, including the newer semantic providers and viewer refinements. No Oaink files were changed.

## Recommended scope

Add a task-specific **Review** surface inside OpenCode. The first deliverable includes Difftastic running as WebAssembly, Oaink's structural rendering behavior, and selection-to-chat. A conventional line viewer alone does not satisfy this scope.

Open Review from a task, a changed-file event in Trajectory, or a running worker in Radar. Keep the task, attempt, comparison and selected source together. Architect remains responsible for worker steering and integration through existing runtime actions. Review does not add a mandatory human approval, semantic score, or scheduler hold.

## What Oaink actually implements

| Source                                                                                              | Existing behavior to retain                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/providers/difft/src/run.ts`: `runDifft()`                                                 | Runs pinned Difftastic 0.71.0 for a file pair and requests its JSON alignment and changed tokens. This adapter currently spawns a native executable.                      |
| `packages/providers/difft/src/difftastic.ts`: `parseDifftJson()`, `toTokens()`                      | Converts the engine's output, including UTF-8 byte offsets to UTF-16 columns. Handles whole-line and per-character fallback cases without drawing misleading token boxes. |
| `packages/pierre/src/structural.ts`: `toPierreDiff()`                                               | Supplies alignment, changed rows and token ranges to `createStructuralDiff()`. Pierre renders these results; it does not replace them with its own text-diff alignment.   |
| `packages/providers/difft/src/classify.ts`: `classifyFile()`, `classifyUnpaired()`                  | Classifies signature/body changes, formatting, renames, moves across files, additions and removals.                                                                       |
| `packages/webviews/diff/sections/derive.ts`: `fileSections()`                                       | Makes changed symbols the review units, with separate sections for changes outside symbols.                                                                               |
| `packages/webviews/diff/session.ts`: `DiffSession`                                                  | Loads file shapes before text, fetches text near the viewport, cancels obsolete reads, restores source anchors and updates individual items.                              |
| `packages/webviews/diff/RangeView.tsx`: `viewportOf()`                                              | Preserves the source row at the top while sections and inline annotations change geometry.                                                                                |
| `packages/webviews/diff/threads/Threads.tsx`: `selectedLines()`                                     | Resolves selection through shadow DOM and binds it to one file, one side and an inclusive line range.                                                                     |
| `packages/schema/src/draft.ts`: `ThreadAnchor`; `packages/engine/src/drafts/service.ts`: `locate()` | Pins comments to a commit and side-specific path. Moves a comment with an unchanged symbol; otherwise retains its original location as outdated.                          |
| `packages/lens/src/references.ts`: `createLensReferenceRegistry()`                                  | Issues actual navigation references for model replies. The model copies references instead of inventing links or UI commands.                                             |

The renderer is a fork, not stock Pierre. `packages/pierre/package.json` uses `pierre-diffs-1.5.2-oaink.6.tgz`. `vendor/README.md` records host-supplied token ranges, neutral one-sided rows, overscan, annotation height estimates, partial render offsets and the fix that keeps the last retained annotation during trimming. Replacing this with an unmodified dependency risks losing those behaviors.

The inspected reference image is `apps/site/public/shots/review-signature.dark-modern.webp`. `docs/design.md` defines quiet gutter changes, syntax-colored token marks, readable unchanged code, collapsed moves/formatting, and one-sided rendering for wholly added/deleted files. Decision 0056 supersedes the older repeated tool/provenance chips. Use LAZERS/OpenCode theme tokens for this presentation.

## Use the task data already stored

[AttemptRow](../src/runner/store.ts) records `plan_id`, `task_id`, `session_id`, `workspace`, `base_commit`, `artifact`, attempt number and Unix start time. [TaskSpecSchema](../src/task.ts) supplies intent, acceptance, source findings and scope. These are the input to review; another independently maintained task registry is unnecessary.

### Shared integration branch and PR

The required work workflow collects a selected set of tasks into one feature branch and one associated PR. Architect integrates successive task results into that target; completing a task does not merge its PR into the repository default branch. Accept an existing target or create a new branch/PR through the configured repository workflow. Keep the product's target separate from this repository's contributor instruction to push `main`.

`recordIntegration()` already accepts `targetBranch` and records `{artifact, branch, head}` for task and plan integration. `reviewedBranchHead()` currently requires that target to be checked out in the canonical project directory. Extend this existing authority to support the selected integration target without forcing the user's main checkout to switch branches. The pinned V2 VCS API exposes branch inventory, status, base and diff; its public surface has no PR creation/update operation. Use the repository's configured PR tooling rather than a second agent runner or bundled native executable.

Persist the target/base/PR association with the task group and retain each attempt's authoritative native workspace path after cleanup. Record the observed target range before/after integration and the landed commits associated with each task. Preserve source artifact/base identity separately: merge, squash and cherry-pick can change commit identity. A batch integration may share a range across tasks; record that relationship instead of claiming exclusive authorship from file attribution. Existing history stays readable; missing legacy metadata does not invalidate accepted work.

Review must show source-attempt changes and the actual integrated changes, including conflict resolutions, with navigation to the shared PR. Preserve the source needed to reopen historical comparisons after worker worktree/branch cleanup and PR history changes. Name the panel **Review**, including when the host also has a Review panel; the plugin-scoped ID distinguishes them. Source provenance is not product branding.

[VerificationReview.taskChainBase()](../src/runner/verification-review.ts) already follows repair/resume ancestry. A repair's immediate base includes earlier task work, so that base alone would omit part of the feature. A retry from a different baseline starts a new chain. Reuse this rule in review queries rather than introducing another definition.

Proposed comparisons:

| Choice       | Input → displayed change                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task         | `taskChainBase(attempt)` → accepted/latest task artifact; includes its retained repair chain.                                                                                |
| Attempt      | `AttemptRow.base_commit` → that attempt's artifact.                                                                                                                          |
| Since review | Previously reviewed artifact → selected newer artifact.                                                                                                                      |
| Live         | Assigned workspace snapshot against the recorded task base; includes staged, unstaged and untracked source. Keep the displayed snapshot stable until a newer one is applied. |
| Plan         | Plan base → combined candidate, with task attribution and dependency context.                                                                                                |

Read committed content from Git objects after native worktree cleanup. Review must not reopen or recreate removed checkouts just to display old code. Keep uncommitted selections as captured excerpts with their snapshot identity; a path to a mutable file alone cannot preserve them.

Tool/file activity and net changes answer different questions. Trajectory supplies the observed operations and time. The selected Git comparison supplies the resulting source change. In shared serial workspaces, do not claim that every uncommitted workspace edit belongs to one task solely because an agent touched the file.

[FallowPackage](../src/audit/contract.ts) already carries introduced/worsened/inherited findings, locations, symbols, related locations and task IDs. [fallowPlanReview()](../src/audit/review-plan.ts) and [attributeFindingsToTasks()](../src/audit/task-attribution.ts) already detect combined-plan findings and attach the tasks whose diffs touched their files. This attribution is file-based, not proof of line-level authorship. Reuse the stored output and show all contributing tasks where appropriate.

## Selection to a targeted correction

Proposed interaction:

1. Open `LZ-276 → Review`. Choose Task, an attempt, Since review, or Plan.
2. Select a symbol or code range. Choose **Ask Architect** or **Request fix**.
3. Open the Architect conversation with a native attachment and an editable draft. Preserve any existing draft. The user sends it.
4. Architect reads the pinned source, task intent, existing findings and checks. It answers, steers the current worker through existing advice/recovery, or creates linked correction work when the change is already integrated.
5. A newer artifact updates the comparison. Keep the thread and allow a direct jump to the corrective change.

The installed SDK provides the needed composer operations in `node_modules/@opencode/plugin/dist/gui/host-apis.d.ts`:

- `Composer.attach(ComposerFile)` supports a file selection, preview and comment for current workspace source.
- `Composer.attach(ComposerQuote)` preserves the actual selected text in the draft and sent message.
- `Composer.attach(ComposerNote)` supports a task/review reference with a plugin link and descriptive subject.
- `Composer.focus()` opens the comment editor or composer. These APIs do not send a prompt.

Use a file attachment only when its current workspace content is the source being referenced. For deleted/base-side code or a historical artifact, use the captured quote and a typed review reference. Otherwise the model could read today's line number in place of the code the user selected.

A proposed review anchor contains project/task/attempt identity, the comparison's base/head revisions, side-specific path, line/column range, optional symbol, selected excerpt, and Unix creation time. A review-thread record owns comments and their disposition. Task specifications stay immutable. These anchors identify source; they are not evidence certificates or acceptance gates. Persisted excerpts/comments/findings need credential redaction before database writes, with source coordinates retained. Do not apply trajectory display truncation to the review source. Define any durable thread/workflow transitions in XState through the existing lifecycle registry; reuse the existing advice and correction flows for worker actions.

Use OpenCode's configured models and the native Architect for review questions. Reuse Oaink's reference/tool concepts without embedding its separate Lens harness or another agent runner. Architect and the human should read the same comparison and findings.

Extend [createTaskLinkHandler()](../src/tasks/links.ts) for review targets instead of creating an unrelated link router. A click must restore the exact task, comparison, file and selection. Oaink's issued-reference approach can make Architect explanations navigate back to those same source locations.

Subagent sessions have no composer according to the SDK. A selection made while viewing an Implementor must route to the current project Architect conversation, not call the worker screen's inert composer. Resolving/opening that conversation while preserving both drafts is an integration case to exercise explicitly.

## WASM inventory and port plan

`apps/daemon/src/settings.ts:resolveExtensions()` is the inventory of current Oaink providers. Older vision documents also describe future tools; they are not evidence that those tools run today.

| Component                          | Current implementation                                                                                 | LAZERS route                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Difftastic 0.71.0                  | Native subprocess through `runDifft()`                                                                 | Required WASM port in the first deliverable. Preserve the existing parser/output semantics and feed `toPierreDiff()`.                                                                                                        |
| Symbol index and language adapters | `web-tree-sitter` 0.27.0 plus WASM grammars; TS/JS/TSX, Rust and Python adapters                       | Reuse parser/extraction logic in an OpenCode-owned worker. Bundle the required WASM assets without native grammar addons.                                                                                                    |
| `shape`, `comments`, `api-ts`      | TypeScript rules over symbols, test/documentation observations and module graphs; provider `tools: []` | Adapt their data inputs and run in a worker. They do not need a new native-to-WASM compiler port.                                                                                                                            |
| `reach-ts`, `diag-ts`              | `typescript-ls` 5.9.3 in a JavaScript worker, not the Go `tsc` executable                              | Bundle/reuse the language-service worker and its filesystem adapter. Preserve its distinctions between resolved references and import-name heuristics.                                                                       |
| Fallow                             | Oaink uses a native command adapter                                                                    | Reuse LAZERS' existing WASM analysis and durable `FallowPackage`, rather than install Oaink's native Fallow.                                                                                                                 |
| `cccc` 1.7.0                       | Native Rust executable for complexity across its supported languages                                   | Add a WASM entry around the language/core crates. Keep its measurements distinct from Fallow's where both analyze the same function.                                                                                         |
| `jscpd` 5.4.0                      | Native Rust executable, multiple clone detectors                                                       | Port core/tokenization/detection behind a WASM entry. Keep filesystem/Git orchestration with the host. Oaink explicitly does not run its model-backed `--semantic` mode.                                                     |
| `gitleaks` 8.30.1                  | Native Go executable                                                                                   | Build a WASI detector adapter over the selected file contents. Check regex/runtime dependencies and allowlist behavior; Go WASI support alone does not establish that this dependency graph compiles or behaves identically. |
| Pierre and fast highlighting       | JavaScript renderer; `@pierre/highlights` supplies WASM lexers                                         | Reuse rather than rewrite. Package its worker scripts and test them under OpenCode's real origin/CSP.                                                                                                                        |

Difftastic is the first port, not a later enhancement. At its pinned source, [`diff_file_content()`](https://github.com/Wilfred/difftastic/blob/0.71.0/src/main.rs) already compares supplied strings, while `diff_file()` performs file I/O. Start a thin WASM entry around the content comparison and existing JSON projection. Keep directory walking and Git integration in the OpenCode host.

Concrete port issues in that source: the `GLOBAL: Jemalloc` target condition does not exclude WASM, `diff_directories()` uses Rayon, and tree-sitter parser C sources need a WASM build. Exclude the native allocator and CLI-only paths from the WASM target and retain the syntax comparison algorithm. Do not substitute an AST approximation or Pierre's line alignment.

The other Rust tools have separable starting points: [`cccc-core`](https://github.com/moznion/cccc/blob/v1.7.0/crates/cccc-core/src/lib.rs), and jscpd's [`cpd-core`](https://github.com/kucherenko/jscpd/blob/v5.4.0/rust/crates/cpd-core/Cargo.toml)/[`cpd-finder`](https://github.com/kucherenko/jscpd/blob/v5.4.0/rust/crates/cpd-finder/Cargo.toml). Their native threading/filesystem adapters still need inspection during the port. [Go supports `wasip1`](https://go.dev/blog/wasi), but [Gitleaks' dependencies](https://github.com/gitleaks/gitleaks/blob/v8.30.1/go.mod) also need a detector-level build exercise. No new WASM build or native/WASM parity run was performed for this proposal.

Run analysis in workers hosted by OpenCode, with no separate daemon or native analyzer downloads. Reuse the existing WASI filesystem, buffered I/O and memory-release behavior where applicable; extract shared pieces only when a second module needs them. Do not copy the Fallow host wholesale into parallel runtimes. Keep compiled-module caches separate from per-run linear memory, ASTs and source buffers.

Ordinary source reading and a conventional diff remain usable for unsupported syntax or an analysis failure. Report the affected comparison locally; do not make an analyzer failure hold task dispatch or integration.

## Viewer integration

Oaink's webviews are React/StyleX; LAZERS uses host-provided Solid. The fork also exports an imperative `CodeView` with `setItems()`, `updateItem()`, `setSelectedLines()` and `cleanUp()`. Prefer a small Solid adapter around that core and reuse framework-independent conversion/session/section logic. Confirm the fork's imperative annotation slots and worker lifecycle in the integration increment. This avoids introducing Oaink's entire React/Fate/daemon stack.

The SDK's `Changes` contract exposes the routed session's native diff, readiness, focus and open operations. It does not expose semantic annotation or an arbitrary task-artifact comparison API. Keep native review navigation available; the task-specific semantic comparison needs its own LAZERS panel/data source.

Reuse native `Panel`, composer attachments and link handling. Use the existing stream/SQLite model for paged file/symbol/finding/thread data, with viewport source-text reads. Invalidate affected files from task/artifact and recorded editing events rather than polling full diffs. A late analysis result must retain its comparison identity and never overwrite a newer comparison.

Use one column at panel width: compact task/comparison controls, file/symbol navigation, code, then selected details. Offer paired panes when width permits. Use short icon actions with tooltips, theme colors and expandable inline findings. Keep detailed source/tool metadata in inspection, not repeated paragraph labels.

## Coherent implementation increments

1. **Difftastic WASM and structural source contract.** Run Oaink's pinned native engine and the WASM build against the same existing file-pair fixtures. Match alignments, changed tokens, statuses, language handling and UTF conversion. Exercise cancellation, memory release and the packaged asset in OpenCode.
2. **Task Review and selection to Architect.** Resolve real attempt/task/plan comparisons, mount the fork through Solid, support virtualized symbol sections, retain source-pinned threads and draft attachments. Exercise a real correction on a retained worker and reopen its source after worktree cleanup.
3. **Semantic review facts and remaining tool ports.** Adapt existing WASM/JS providers and Fallow output; port cccc/jscpd/gitleaks. Reuse each provider's existing positive/negative fixtures and compare native versus WASM output. Surface API/caller/test/complexity/duplication facts at their code locations.
4. **Plan and follow-up review.** Show cross-task findings, changes since review, moved/outdated anchors and corrections after integration. Reuse task attribution, linked correction history and the existing scheduler flow.

These are feature slices for Architect planning, not file-by-file tasks. The first usable review release includes increments 1 and 2. The remaining semantic inventory stays explicit until its ports land.

## Carry the hardening forward

Oaink has targeted regressions worth adapting, rather than inventing a new benchmark:

- `diff/session.test.ts`: near-viewport text, cancelled reads, shape-first layout, wrap changes, retry, same-session reveal and restored anchors.
- `diff/locate.test.ts`, `diff/scope.test.ts`: innermost symbol, side/path ranges, scoped file order, no navigation echo and no stale scope.
- `test/unmounted-height.visual.ts`: annotation rows survive trimming, expanded rows retain height, 250-file ranges and wrapped long lines keep their geometry.
- `diff/mark-room.test.ts`, the contrast fixtures and token conversion tests: font metrics, device scale, Unicode columns, whole-line changes and theme contrast.
- Draft and reference tests: renamed paths, removed code, unchanged symbols that move, genuinely changed source, multiple hunks and model-issued references.

Add LAZERS-specific cases for repair-chain bases, concurrent prerequisites, removed worktrees, a worker screen with no composer, existing Architect draft preservation, historical/base selection, and correction deltas. Exercise the assembled panel in regular OpenCode Desktop, including narrow/wide layouts and real worker edits. Analysis failures and human review marks must not introduce new workflow gates.
