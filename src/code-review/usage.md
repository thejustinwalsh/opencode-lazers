# Code review consumer API

`CodeReview` (`lazers.codeReview`) selects durable task comparisons and reads pinned source.
`codeReview.files` is a keyset stream over one side's complete inventory; omit `changedOnly` to
include unchanged source, configuration and ignore files. The server supplies the project path
after checking the named session's read permission.

```ts
import { CodeReview, CodeReviewSourceIdentitySchema } from "./contract.ts"
import { Streams } from "../streams/contract.ts"
import { rpcStreamsTransport, readWindow } from "../streams/gui.ts"
import type { StreamsRpc } from "../streams/gui.ts"
import { codeReviewFilesRef } from "../streams/sources/code-review-ref.ts"

const location = { location: { directory: projectDirectory } }
const review = client.rpc(CodeReview)
const comparison = await review.resolve(
  { sessionID, taskID, mode: "task" },
  { ...location, signal },
)

const streams = rpcStreamsTransport(
  () => client.rpc(Streams) as unknown as StreamsRpc,
  signal,
  location,
)
const files = await readWindow(streams, codeReviewFilesRef, {
  filter: {
    comparisonID: comparison.identity.comparisonID,
    side: "head",
    scope: { kind: "session", sessionID },
  },
  order: "path",
  window: 100,
})
const file = files[0]
```

Each file row carries its side, relative path, content object identity, metadata, changed status,
hunks and plan task attribution. Use that exact tuple to read a source window; never resolve a Git
revision or workspace path in the UI:

```ts
if (!file || typeof file.path !== "string" || typeof file.object_id !== "string")
  throw new Error("The selected side has no source at this path")
const identity = comparison.identity
const source = CodeReviewSourceIdentitySchema.parse({
  version: identity.version,
  projectID: identity.projectID,
  taskID: identity.taskID,
  planID: identity.planID,
  attemptID: identity.attemptID,
  comparisonID: identity.comparisonID,
  mode: identity.mode,
  side: "head",
  path: file.path,
  revision: file.object_id,
})
const shape = await review.shape({ sessionID, source }, { ...location, signal })
if (shape.kind !== "text" || shape.lineCount === null || shape.lineCount === 0)
  throw new Error("The selected file has no readable source lines")
const window = await review.source(
  { sessionID, source, startLine: 1, endLine: Math.min(shape.lineCount, 80) },
  { ...location, signal },
)
```

Structural analysis reads both selected sides from that immutable comparison. It returns the engine's
alignment, token ranges and comments together with the exact source identities; `previousPath` is
the base-side path for a rename. A missing side is represented by `null`, while an existing empty
file is read as `""`:

```ts
const structural = await review.structural(
  {
    sessionID,
    comparisonID: identity.comparisonID,
    path: file.path,
  },
  { ...location, signal },
)
if (structural.status === "ready") {
  const { diff, baseSource, headSource, sourceID } = structural
  // Apply only while comparisonID/sourceID still match the selected file.
}
```

For a moved path, pass the old path explicitly as `previousPath`; the returned `baseSource.path`
remains the actual base-side path:

```ts
const moved = await review.structural(
  { sessionID, comparisonID: identity.comparisonID, path: newPath, previousPath: oldPath },
  { ...location, signal },
)
```

Call `markReviewed` only for an explicit user review action. It is idempotent, does not alter task
workflow, and pins the selected comparison so an older artifact remains addressable after an attempt
advances:

```ts
const baseline = await review.markReviewed(
  { sessionID, comparisonID: identity.comparisonID, requestID },
  { ...location, signal },
)
const since = await review.resolve(
  { sessionID, taskID, mode: "since", baseComparisonID: baseline.comparisonID, headAttemptID },
  { ...location, signal },
)
const reviewed = await review.reviewed({ sessionID, taskID, limit: 50 }, { ...location, signal })
```

For `attempt`, provide `attemptID`; for `since`, provide `baseAttemptID` and `headAttemptID`; for
`plan`, provide `planID`. `live` accepts an optional `attemptID` and returns `base`, `head`,
`staged`, `unstaged` and `untracked` sides with an immutable `snapshotID`. A Live result records
whether edits came from an assigned or shared workspace. A source read is pinned to the selected
comparison even after its worker workspace is removed. `history` is keyset-paged with its
`nextCursor`; source windows are limited to 500 lines.

The attempt-pair `since` form remains supported. `CodeReviewDiscussions` and
`CodeReviewIntegrations` publish the agreed RPC schemas for their independent implementations;
their handlers are not registered by this structural-review bridge. Discussion references carry a
validated relative task-route `href`; integration records keep the target's base branch separate
from the worker's source branch and expose shared-batch membership explicitly.
