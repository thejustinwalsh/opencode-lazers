import { blobBytes, diffHunks, treeFiles } from "./git.ts"
import {
  CODE_REVIEW_CONTRACT_VERSION,
  CodeReviewComparisonSchema,
  CodeReviewSourceIdentitySchema,
  type CodeReviewComparison,
  type CodeReviewComparisonIdentity,
  type CodeReviewHistory,
  type CodeReviewHistoryInput,
  type CodeReviewResolveInput,
  type CodeReviewSide,
  type CodeReviewSourceIdentity,
  type CodeReviewSourceShape,
  type CodeReviewSourceWindow,
  type CodeReviewSourceWindowInput,
} from "../contract.ts"
import type { TaskRepository } from "../../storage.ts"
import { fingerprint } from "../../identity.ts"
import type { RunnerStore } from "../../runner/store.ts"
import type { ComparisonBlob, ComparisonFile } from "./store.ts"
import { CodeReviewStore } from "./store.ts"
import {
  CodeReviewSelectionResolver,
  REVIEW_ATTEMPT_COLUMNS,
  type ComparisonSelection,
  type ReviewAttempt,
} from "./selection.ts"
import {
  allPairRows,
  flattenPlanAttribution,
  gitFileEntry,
  kindFor,
  lineCount,
  lineOffsets,
} from "./inventory.ts"

const HISTORY_PAGE_SIZE = 50

export class CodeReviewResolver {
  readonly store: CodeReviewStore
  private readonly selection: CodeReviewSelectionResolver

  constructor(
    readonly repository: TaskRepository,
    runner: RunnerStore,
    readonly projectID: string,
  ) {
    this.store = new CodeReviewStore(repository)
    this.selection = new CodeReviewSelectionResolver(repository, runner)
  }

  async history(
    input: Pick<CodeReviewHistoryInput, "taskID" | "limit" | "cursor">,
    signal: AbortSignal,
  ): Promise<CodeReviewHistory> {
    signal.throwIfAborted()
    const task = this.repository.get(input.taskID)
    if (!task) throw new Error("Task is unavailable in this project")
    const limit = input.limit ?? HISTORY_PAGE_SIZE
    const cursor = input.cursor
    const page = this.repository.read((db) =>
      db
        .query<ReviewAttempt, [string, string, number, number, string, number]>(
          `SELECT ${REVIEW_ATTEMPT_COLUMNS}
           FROM runner_attempts a
           WHERE a.project_directory=? AND a.task_id=?
             AND (a.started_at,a.number,a.id)>(?,?,?)
           ORDER BY a.started_at,a.number,a.id
           LIMIT ?`,
        )
        .all(
          this.repository.projectDirectory,
          task.id,
          cursor?.startedAt ?? -1,
          cursor?.attemptNumber ?? 0,
          cursor?.attemptID ?? "",
          limit + 1,
        ),
    )
    signal.throwIfAborted()
    const revisions = page.slice(0, limit)
    const last = revisions.at(-1)
    return {
      taskID: task.id,
      revisions: revisions.map((row) => ({
        planID: row.plan_id,
        attemptID: row.id,
        attemptNumber: row.number,
        state: row.state,
        baseRevision: row.base_commit,
        artifactRevision: row.artifact,
        startedAt: row.started_at,
      })),
      nextCursor:
        page.length > limit && last
          ? { startedAt: last.started_at, attemptNumber: last.number, attemptID: last.id }
          : null,
    }
  }

  async resolve(input: CodeReviewResolveInput, signal: AbortSignal): Promise<CodeReviewComparison> {
    signal.throwIfAborted()
    const task = this.repository.get(input.taskID)
    if (!task) throw new Error("Task is unavailable in this project")
    const selection = await this.selection.select(task.id, input, signal)
    const inventory = await this.inventoryFor(selection, signal)
    const comparison = this.comparisonFor(
      task,
      input.mode,
      selection,
      inventory.files,
      inventory.planContext,
    )
    signal.throwIfAborted()
    return this.store.persist(comparison, inventory.files, inventory.blobs)
  }

  private async inventoryFor(selection: ComparisonSelection, signal: AbortSignal) {
    if (selection.files !== undefined)
      return {
        files: selection.files,
        blobs: selection.blobs ?? [],
        planContext: selection.planContext,
      }
    return this.historicalFiles(selection.base, selection.head, selection.planContext, signal)
  }

  private comparisonFor(
    task: NonNullable<ReturnType<TaskRepository["get"]>>,
    mode: CodeReviewResolveInput["mode"],
    selection: ComparisonSelection,
    files: readonly ComparisonFile[],
    planContext: CodeReviewComparison["planContext"],
  ): CodeReviewComparison {
    const uniquePaths = new Set(files.map((file) => file.path))
    const changedPaths = new Set(files.filter((file) => file.changed).map((file) => file.path))
    const stableIdentity = {
      version: CODE_REVIEW_CONTRACT_VERSION,
      projectID: this.projectID,
      taskID: task.id,
      planID: selection.selectedPlanID,
      attemptID: selection.selectedAttemptID,
      mode,
      baseRevision: selection.base,
      headRevision: selection.head,
      snapshotID: selection.snapshotID,
    } as const
    const comparisonID = fingerprint({
      ...stableIdentity,
      planContext,
      attribution: selection.attribution,
    })
    const identity: CodeReviewComparisonIdentity = {
      ...stableIdentity,
      comparisonID,
      capturedAt: selection.capturedAt,
      attribution: selection.attribution,
    }
    const comparison = CodeReviewComparisonSchema.parse({
      identity,
      available: true,
      unavailableReason: null,
      fileCount: uniquePaths.size,
      changedCount: changedPaths.size,
      sides: selection.mainSides,
      sourceName: "codeReview.files",
      taskReference: this.repository.referenceFor(task.id) ?? task.id,
      taskTitle: task.proposal.objective.slice(0, 120),
      planContext,
    })
    return comparison
  }

  async shape(
    source: CodeReviewSourceIdentity,
    signal: AbortSignal,
  ): Promise<CodeReviewSourceShape> {
    return (await this.inspectSource(source, signal)).shape
  }

  private async inspectSource(
    source: CodeReviewSourceIdentity,
    signal: AbortSignal,
  ): Promise<{ shape: CodeReviewSourceShape; content?: Uint8Array }> {
    const file = this.requirePinnedFile(source, signal)
    const content = await this.readTextContent(file, signal)
    signal.throwIfAborted()
    return {
      shape: sourceShape(source, file, content),
      ...(content ? { content } : {}),
    }
  }

  private requirePinnedFile(source: CodeReviewSourceIdentity, signal: AbortSignal) {
    signal.throwIfAborted()
    this.assertPinnedSource(source)
    const file = this.store.file(source.comparisonID, source.side, source.path)
    if (!file || file.objectID !== source.revision) throw new Error("Pinned source is unavailable")
    return file
  }

  private readTextContent(
    file: NonNullable<ReturnType<CodeReviewStore["file"]>>,
    signal: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    if (file.kind !== "text" && !(file.kind === "unknown" && !file.objectID?.startsWith("sha256:")))
      return Promise.resolve(undefined)
    return this.sourceBytes(file.objectID!, signal)
  }

  async sourceWindow(
    input: CodeReviewSourceWindowInput,
    signal: AbortSignal,
  ): Promise<CodeReviewSourceWindow> {
    const source = CodeReviewSourceIdentitySchema.parse(input.source)
    validateWindowRange(input)
    const { shape, content } = await this.inspectSource(source, signal)
    const lineCount = validateWindowShape(shape, input.endLine)
    const bytes = content ?? (await this.sourceBytes(source.revision, signal))
    signal.throwIfAborted()
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const window = sourceWindowText(text, input.startLine, input.endLine)
    signal.throwIfAborted()
    return {
      source,
      startLine: input.startLine,
      endLine: input.endLine,
      lineCount,
      text: window,
    }
  }

  private assertPinnedSource(source: CodeReviewSourceIdentity): CodeReviewComparison {
    const comparison = this.store.comparison(source.comparisonID)
    if (
      !comparison ||
      comparison.identity.projectID !== this.projectID ||
      comparison.identity.taskID !== source.taskID ||
      comparison.identity.planID !== source.planID ||
      comparison.identity.attemptID !== source.attemptID ||
      comparison.identity.mode !== source.mode
    )
      throw new Error("Pinned source does not belong to this project comparison")
    return comparison
  }

  sourceIdentity(
    comparison: CodeReviewComparison,
    side: CodeReviewSide,
    path: string,
  ): CodeReviewSourceIdentity {
    const file = this.store.file(comparison.identity.comparisonID, side, path)
    if (!file?.objectID || file.kind === "absent")
      throw new Error("The selected comparison side has no source at this path")
    return CodeReviewSourceIdentitySchema.parse({
      version: CODE_REVIEW_CONTRACT_VERSION,
      projectID: comparison.identity.projectID,
      taskID: comparison.identity.taskID,
      planID: comparison.identity.planID,
      attemptID: comparison.identity.attemptID,
      comparisonID: comparison.identity.comparisonID,
      mode: comparison.identity.mode,
      side,
      path,
      revision: file.objectID,
    })
  }

  private async sourceBytes(blobID: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    const cached = this.store.blob(blobID)
    if (cached) return cached
    if (blobID.startsWith("sha256:")) throw new Error("Captured live source content is unavailable")
    return blobBytes(this.repository.projectDirectory, blobID, signal)
  }

  private async historicalFiles(
    base: string,
    head: string,
    planContext: CodeReviewComparison["planContext"],
    signal: AbortSignal,
  ) {
    const root = this.repository.projectDirectory
    const [baseTree, headTree, changes] = await Promise.all([
      treeFiles(root, base, signal),
      treeFiles(root, head, signal),
      diffHunks(root, base, head, signal),
    ])
    const baseEntries = new Map([...baseTree].map(([path, file]) => [path, gitFileEntry(file)]))
    const headEntries = new Map([...headTree].map(([path, file]) => [path, gitFileEntry(file)]))
    const attribution = flattenPlanAttribution(planContext?.taskFiles ?? {})
    const files = allPairRows(
      baseEntries,
      headEntries,
      { before: "base", after: "head" },
      changes,
      attribution,
    )
    signal.throwIfAborted()
    return { files, blobs: [] as ComparisonBlob[], planContext }
  }
}

function sourceShape(
  source: CodeReviewSourceIdentity,
  file: NonNullable<ReturnType<CodeReviewStore["file"]>>,
  content?: Uint8Array,
): CodeReviewSourceShape {
  const kind = content ? kindFor(file.path, file.mode, content) : file.kind
  const count = kind === "text" && content ? lineCount(content) : null
  return {
    source,
    exists: true,
    kind,
    size: file.size ?? content?.byteLength ?? null,
    lineCount: count,
    status: file.status,
    changed: file.changed,
    hunks: file.hunks,
    attributionTaskIDs: file.attributionTaskIDs,
  }
}

function validateWindowRange(input: CodeReviewSourceWindowInput): void {
  if (input.endLine < input.startLine || input.endLine - input.startLine >= 500)
    throw new Error("Source reads cover 1–500 lines")
}

function validateWindowShape(shape: CodeReviewSourceShape, endLine: number): number {
  if (shape.kind !== "text" || shape.lineCount === null)
    throw new Error("Selected source is binary or unavailable as text")
  if (endLine > shape.lineCount) throw new Error("Source window extends past the pinned file")
  return shape.lineCount
}

function sourceWindowText(text: string, startLine: number, endLine: number): string {
  const offsets = lineOffsets(text)
  const start = offsets[startLine - 1]
  const end = endLine >= offsets.length ? text.length : offsets[endLine]
  if (start === undefined || end === undefined) throw new Error("Pinned line range is unavailable")
  const window = text.slice(start, end)
  if (window.length > 2_000_000) throw new Error("Source window exceeds the two-megabyte limit")
  return window
}
