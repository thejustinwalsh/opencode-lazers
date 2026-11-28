# Review consumer contract

Agreed interface for the next implementation increment, based on `ee8c1366`.
Existing operations are available now. New operations below are specifications
until their native handlers land; they are not alternative UI endpoints.

## Ownership and integration

- External Opus owns `src/code-review/ui/**`, the Solid/imperative Pierre adapter,
  GUI entry, navigation and styles, and UI dependencies in `package.json`,
  `bun.lock` and the vendored renderer. The product label is **Review**.
- Native Luna Max workers own server contracts, RPC, comparison/analysis reads,
  integration lineage, discussion storage and streams.
- Keep one external UI lane within the project limit of three delegated lanes.
  Architect composes additive shared registrations; workers do not chase moving
  branches or replace one another.
- Oaink is read-only reference. Use `DESIGN.md`, `design/task-code-review.md`,
  its screenshot/design references and the hardened fork, not a new dashboard.

```text
integration-authority audit ─┐
                            ├─ shared target + actual lineage ─ discussions
structural consumer bridge ─┘                                  + draft references
external Opus UI ─────────────────────────────────────────────── assembled Review
```

The audit informs the target feature, not the independent structural bridge.
Optional semantic JS/language-service enrichment stays on the roadmap.

## Existing reads

Import `CodeReview` from `src/code-review/contract.ts`.
Its RPC ID remains `lazers.codeReview`.

| Operation | Purpose                                         |
| --------- | ----------------------------------------------- |
| `resolve` | Task, Attempt, Since, Live and Plan comparisons |
| `history` | Paged attempt/artifact selections               |
| `shape`   | Shape of an exact `CodeReviewSourceIdentity`    |
| `source`  | Pinned near-viewport source window              |

Use `codeReviewFilesRef` for `codeReview.files`; keep its existing authorization
and paging. Use `taskDetailRef` and its cold fields `body`, `execution`,
`advice`, `audit_history` and `architect_session_id` for actual task context.
Do not introduce another task registry or duplicate context RPC.

## Pinned structural analysis

Extend `CodeReview` with:

```ts
type CodeReviewStructuralInput = {
  sessionID: string
  comparisonID: string
  path: string
  previousPath?: string
  baseSide?: CodeReviewSide // default "base"
  headSide?: CodeReviewSide // default "head"
}

type CodeReviewStructuralResult = {
  comparison: CodeReviewComparisonIdentity
  sourceID: string
  baseSource: CodeReviewSourceIdentity | null
  headSource: CodeReviewSourceIdentity | null
  status: "ready" | "unavailable"
  diff: StructuralDiff | null
  reason: "binary" | "confidential" | "unsupported-kind"
    | "source-unavailable" | "both-absent" | null
}

CodeReview.structural(input: CodeReviewStructuralInput)
  // -> CodeReviewStructuralResult
```

The server reads immutable inventory/source, not text supplied by the client.
`previousPath` is the base-side path and is independently validated. One absent
side is valid for additions/deletions; unavailable source is not an absent file.
`sourceID` binds both side identities, absence markers and engine version.
Pass through the existing `StructuralDiff` alignment, changed tokens, UTF-16
columns, comments, engine and degraded reason without realignment in the UI.
Fallback remains a ready line-engine diff, not a null result.

RPC cancellation must reach the worker and settle its resources. Requests from
different files or viewers must not cancel each other. The UI applies a result
only to its exact selected comparison/source identity.

Add `CodeReview.markReviewed({sessionID, comparisonID, requestID})` returning
`CodeReviewReviewedBaseline`, and
`CodeReview.reviewed({sessionID, taskID, limit?, cursor?})` returning a paged
baseline list. This is an optional explicit user mark, never task approval.
Extend `resolve`'s `since` form with `baseComparisonID` plus `headAttemptID`,
preserving the existing attempt-pair form. A cached comparison alone is not a
review mark. A baseline retains its exact source or integrated-target identity,
including an older artifact from the same attempt.

## Shared feature target and actual integrations

The product workflow collects selected tasks into one feature branch and one PR,
existing or new. Later tasks update that same association. It does not merge the
PR into the default branch. Repository contributor instructions are separate.

Reuse `recordIntegration`, stable change identity and native worktree ownership.
Persist a shared `CodeReviewIntegrationTarget` with target/base/PR association.
Retain source attempt/base/artifact and its native worktree identity separately
from `CodeReviewIntegration`'s observed target-before/after commits, ordered landed
commits and proof relationship. A batch may share one range across multiple tasks.
Containment is not by itself proof of exclusive authorship or a full landed range.
Uncertain legacy lineage stays explicit; accepted legacy work is not invalidated.

UI-facing reads are declared in
`src/code-review/integrations/contract.ts`:

```ts
// RPC ID: "lazers.codeReviewIntegrations"
CodeReviewIntegrations.list({sessionID, taskID, limit?, cursor?})
  // -> { integrations: CodeReviewIntegration[], nextCursor }
CodeReviewIntegrations.resolve({sessionID, taskID, integrationID})
  // -> CodeReviewIntegratedComparison

type CodeReviewIntegratedComparison = {
  comparison: CodeReviewComparison
  integration: CodeReviewIntegration
}
```

The returned comparison is an immutable, actual target-range comparison; its
identity remains usable by ordinary `shape`, `source` and `structural`. Keep the
five existing mode identities; integrated provenance is explicit in the wrapper,
not a silent substitution for a worker artifact. UI labels distinguish source
attempt changes from integrated changes and link the associated PR.

Keep the source objects/ranges needed by Review reachable after native cleanup,
source-branch deletion and PR history rewrites. Never recreate a removed checkout
just to read source. Target operation details follow the integration-authority
audit; UI must not invent branch/PR mutation endpoints. Architect uses the
existing integration authority and the repository's configured PR tooling.

## Durable discussions and draft references

Declare `CodeReviewDiscussions` in `src/code-review/discussions/contract.ts`,
RPC ID `lazers.codeReviewDiscussions`. Every operation includes `sessionID`.

| Operation        | Remaining input                                      | Output                              |
| ---------------- | ---------------------------------------------------- | ----------------------------------- |
| `createThread`   | `source`, `range`, `comment?`, `requestID`           | `CodeReviewThread`                  |
| `getThread`      | `threadID`                                           | `CodeReviewThread`                  |
| `appendComment`  | `threadID`, `body`, `requestID`                      | `CodeReviewComment`                 |
| `setThreadState` | `threadID`, `state`, `expectedRevision`, `requestID` | updated thread or revision conflict |
| `prepareDraft`   | `threadID`, `intent: "ask" \| "request-fix"`         | `CodeReviewDraft`                   |
| `locateThread`   | `threadID`, `targetComparisonID`                     | `CodeReviewAnchorLocation`          |
| `linkCorrection` | `threadID`, `correctionTaskID`, `requestID`          | updated navigation metadata         |

`CodeReviewAnchor` contains an exact `CodeReviewSourceIdentity`, range,
server-derived credential-redacted excerpt, optional verified symbol identity,
ID and Unix timestamp. `CodeReviewRange` uses inclusive 1-based lines and
0-based UTF-16 `startCol`/`endCol`, with the last column end-exclusive.
`CodeReviewThread` owns its immutable original anchor, open/resolved state,
revision and timestamps. Comments and lists are paged, not embedded histories.
Writes are idempotent and redact before database writes, including replay data;
source text is not run through trajectory display truncation.

Provide `codeReviewThreadsRef` (`codeReview.threads`, task filter and optional
comparison filter) and `codeReviewCommentsRef` (`codeReview.comments`, thread
filter), under the existing project/session stream authorization pattern.

`CodeReviewDraft` returns a validated current project Architect session or typed
unavailability, a typed `CodeReviewReference`, and plain `quote`/`note` content for
native attachments. It does not create a session, adopt plan ownership, write a
discussion, or send a prompt. The UI opens/focuses that native session and attaches
`ComposerQuote` plus `ComposerNote`, preserving both existing drafts. Only the user
sends. Historical/base selections never become today's `ComposerFile`.

Use a pure review-link maker/parser in `discussions/links.ts`, based on the
existing `.lazers/tasks/<encoded-project>/<task-reference>` route, extended with
`review=<threadID>&comparison=<comparisonID>`. Opus extends the existing task-link
handler; no competing router. Native `lz-read-review({threadID})` returns the same
pinned, redacted discussion/context and issued navigation reference for Architect.
The model copies an issued reference rather than inventing a UI command.

Relocation never mutates the original anchor. Follow only proven unchanged
source/symbol content with explicit path mapping; changed, missing or ambiguous
content is outdated and still opens its original source. Preserve true base paths.
Correction-task relations remain owned by `lz-correct-task`; `linkCorrection`
only associates a thread with an already valid same-goal correction. Include
actual integrated ranges when navigating later corrective work.

## Pinned symbol index and changed sections

These operations are the next producer contract, not available handlers until
their implementation lands. Extend `CodeReview` with `symbols` and `sections`;
export `CodeReviewSymbolPage`, `CodeReviewSymbol` and `CodeReviewSectionPage`.

```ts
CodeReview.symbols({ sessionID, source, limit?, cursor? })
// -> { source, producerVersion, indexID, state, symbols, nextCursor }
// state: "parsed" | "syntax-error" | "no-grammar" | "unavailable"

type CodeReviewSymbol = {
  id: string
  name: string
  qualifiedName: string
  kind: string
  range: CodeReviewRange
  signature: string | null
  parent: string | null
  contentHash: string
  textHash: string
}

CodeReview.sections({
  sessionID, comparisonID, path, previousPath?, baseSide?, headSide?,
  limit?, cursor?
})
// -> { comparison, sourceID, sectionsID, producerVersion,
//      state, sections, nextCursor }
// state: "ready" | "fallback" | "unavailable"
```

Use the same pinned side/path policy as `structural`. An index identity binds
the exact source and parser, grammar and extractor versions. A section identity
also binds both indices, the structural result and classifier version. Cursors
are opaque and bound to that identity; lists are bounded and paged.

Adapt the read-only Oaink declaration extractors for TypeScript, TSX,
JavaScript, Rust and Python, then its `classifyFile`/`classifyUnpaired` and
`fileSections` logic. A symbol section carries its name/kind, change category,
true base/head ranges and paths, identity, and addition/deletion counts.
Outside-symbol changes remain explicit sections. Unsupported or failed parsing
and line-engine diffs retain an honest file-level fallback; an unavailable index
is not evidence of symbol addition or removal. No names are guessed by a model.

Pin and package the intended Tree-sitter runtime and grammar assets explicitly,
including versions in producer identity; do not depend on Repomix's transitive
installation. Parse in a native-owned JavaScript/WASM worker. Cancellation
terminates synchronous parsing and settles resources. Cache flattened facts,
not ASTs or source bodies. Read only validated pinned source; redact
secret-bearing detector fields before they cross worker output, storage or logs.

`contentHash` ignores syntax trivia and supports classification. It is not
strict enough for discussion relocation. Preserve `textHash`, the full symbol
range, qualified name and producer version when deriving an anchor. Only a
unique same-kind/name declaration with identical text, followed by verification
of the selected excerpt/range and explicit rename mapping where necessary,
permits relocation. Existing anchors remain immutable; relocation does not
resolve a concern or create corrective work.

## Complete the retained UI consumers

Continue the existing external UI rather than replacing its renderer or history.
The structural continuation first corrects real history ordering and pinned-link
selection, connects structural/reviewed-baseline operations, bounds loading, and
repairs native routing and worker recovery.

Once the remaining producers land, use `CodeReviewIntegrations.list/resolve`
for actual landed comparison selection and PR navigation. Keep this distinct from
source-attempt changes and show shared-batch membership without claiming exclusive
authorship. Extend `resolve` with the explicit `since` form
`{baseComparisonID, headComparisonID}`, retaining both existing forms. Validate
source/target provenance and recorded progression; never substitute a worker tip
for an actual target revision.

Use durable discussion operations and paged thread/comment streams. A selected
range creates a server-derived anchor; `prepareDraft` supplies the validated
Architect destination, redacted quote/note and issued task-route reference.
Reuse the task link handler, retaining old links only as compatibility inputs.
Current-project Architect fallback must work for unplanned tasks. Match server
and session, preserve both drafts, and let only the user send.

Render real symbol/outside sections through the existing virtualized Pierre
adapter, preserving source position while sections, wrapping and annotations
change geometry. Parsing failure leaves code readable. Connect thread relocation
to exact-text symbol evidence and expose corrective-task and actual corrective
integration navigation through existing correction authority.

After composition and integration, exercise the regular Desktop with native
product probes: real structural rows, source/base/history links, source cleanup,
project Architect routing, existing drafts, durable threads, correction deltas,
target/PR selection, and worker failure/fallback under the actual origin/CSP.
The driver's activation operation is separate from these verification results;
browser-harness or unit results are not Desktop acceptance.
