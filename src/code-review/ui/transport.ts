import { CodeReview } from "../contract.ts"
import type {
  CodeReviewComparison,
  CodeReviewHistory,
  CodeReviewMode,
  CodeReviewSide,
  CodeReviewSourceIdentity,
  CodeReviewSourceShape,
  CodeReviewSourceWindow,
} from "../contract.ts"
import type { StructuralDiff } from "../structural/contract.ts"
import { Streams } from "../../streams/contract.ts"
import { readFrame } from "../../streams/frame.ts"
import { base64ToBytes, readWindow, rpcStreamsTransport } from "../../streams/gui.ts"
import type { StreamsRpc, StreamsTransport } from "../../streams/gui.ts"
import { streamColumns } from "../../streams/source.ts"
import { codeReviewFilesRef } from "../../streams/sources/code-review-ref.ts"
import { taskDetailRef } from "../../streams/sources/tasks-ref.ts"
import type { FileRow, ReviewFile } from "./model/files.ts"

export type ResolveRequest = {
  taskID: string
  mode: CodeReviewMode
  planID?: string
  attemptID?: string
  baseAttemptID?: string
  headAttemptID?: string
}

/** What Review shows about the task besides its code. */
export type ReviewTask = {
  taskID: string
  reference: string
  title: string
  planID: string | null
  /** The plan owner's conversation; selections are discussed there. */
  architectSessionID: string | null
}

/**
 * Structural analysis of one file of a comparison. The server's consumer operation is not
 * published yet; until a transport supplies it, Review shows a conventional line diff for every
 * file. A result names the comparison it belongs to so a late answer never lands on a newer one.
 */
export type FileAnalysis = { comparisonID: string; path: string; diff: StructuralDiff }
export type AnalysisSource = (
  request: {
    comparison: CodeReviewComparison
    file: ReviewFile
    base: CodeReviewSourceIdentity | null
    head: CodeReviewSourceIdentity | null
  },
  signal: AbortSignal,
) => Promise<FileAnalysis | undefined>

/**
 * Where a task's work lands: one shared feature branch or pull request for a plan, and the commits
 * the task actually contributed there. Supplied by the integration-lineage operation once it is
 * published; Review never assumes `main` or treats a worker artifact as the landed commits.
 */
export type IntegrationTarget = {
  branch: string
  pullRequest?: { number: number; url?: string }
  /** The task's landed range on that target, when it has landed. */
  landed?: { baseRevision: string; headRevision: string }
}
export type LineageSource = (
  taskID: string,
  signal: AbortSignal,
) => Promise<IntegrationTarget | undefined>

/** Everything Review reads. The RPC transport is one implementation; tests use another. */
export interface ReviewTransport {
  resolve(request: ResolveRequest, signal: AbortSignal): Promise<CodeReviewComparison>
  history(
    taskID: string,
    cursor: CodeReviewHistory["nextCursor"],
    signal: AbortSignal,
  ): Promise<CodeReviewHistory>
  shape(source: CodeReviewSourceIdentity, signal: AbortSignal): Promise<CodeReviewSourceShape>
  source(
    source: CodeReviewSourceIdentity,
    startLine: number,
    endLine: number,
    signal: AbortSignal,
  ): Promise<CodeReviewSourceWindow>
  /** Pages one side's rows in path order until the cursor is exhausted. */
  files(
    request: { comparisonID: string; side: CodeReviewSide; changedOnly: boolean },
    onPage: (rows: FileRow[]) => void,
    signal: AbortSignal,
  ): Promise<void>
  task(taskID: string, signal: AbortSignal): Promise<ReviewTask | undefined>
  analysis?: AnalysisSource
  lineage?: LineageSource
}

/** Rows per database page of the file inventory. */
const FILE_PAGE = 200

type RpcClient = { rpc(contract: unknown): unknown }
type CallOptions = { signal: AbortSignal; location: { directory: string } }
type ReviewRpc = {
  resolve(input: unknown, options: CallOptions): Promise<CodeReviewComparison>
  history(input: unknown, options: CallOptions): Promise<CodeReviewHistory>
  shape(input: unknown, options: CallOptions): Promise<CodeReviewSourceShape>
  source(input: unknown, options: CallOptions): Promise<CodeReviewSourceWindow>
}

/** Reads every page of one source through a stream: open, slide by a page, close. */
export async function readAllPages<F>(
  transport: StreamsTransport,
  source: typeof codeReviewFilesRef,
  filter: F,
  order: string,
  page: number,
  onPage: (rows: FileRow[]) => void,
  signal: AbortSignal,
) {
  const stream = `review-${crypto.randomUUID()}`
  const columns = streamColumns(source, page)
  const decode = (data: string) => {
    const bytes = base64ToBytes(data)
    const frame = readFrame(bytes.buffer, bytes.byteOffset, columns)
    const rows = Array.from({ length: frame.header.count }, (_, index) => {
      const row = frame.row(index) as Record<string, unknown>
      return Object.fromEntries(Object.keys(columns).map((name) => [name, row[name]]))
    })
    return { rows, after: frame.header.after }
  }
  try {
    let current = decode(
      (await transport.open({ stream, source: source.name, filter, order, window: page })).data,
    )
    for (;;) {
      signal.throwIfAborted()
      onPage(current.rows)
      if (current.after === 0 || current.rows.length === 0) return
      current = decode((await transport.slide(stream, current.rows.length)).data)
    }
  } finally {
    await transport.close(stream).catch(() => {})
  }
}

/** Review over the plugin RPC of one project location, as the routed session. */
export function rpcReviewTransport(input: {
  client: RpcClient
  sessionID: string
  projectDirectory: string
  signal: AbortSignal
}): ReviewTransport {
  const location = { directory: input.projectDirectory }
  const review = () => input.client.rpc(CodeReview) as unknown as ReviewRpc
  const options = (signal: AbortSignal): CallOptions => ({
    signal: AbortSignal.any([signal, input.signal]),
    location,
  })
  const streams = (signal: AbortSignal) =>
    rpcStreamsTransport(
      () => input.client.rpc(Streams) as unknown as StreamsRpc,
      AbortSignal.any([signal, input.signal]),
      { location },
    )
  const scope = { kind: "session" as const, sessionID: input.sessionID }
  return {
    resolve: (request, signal) =>
      review().resolve({ sessionID: input.sessionID, ...request }, options(signal)),
    history: (taskID, cursor, signal) =>
      review().history(
        { sessionID: input.sessionID, taskID, ...(cursor ? { cursor } : {}) },
        options(signal),
      ),
    shape: (source, signal) =>
      review().shape({ sessionID: input.sessionID, source }, options(signal)),
    source: (source, startLine, endLine, signal) =>
      review().source({ sessionID: input.sessionID, source, startLine, endLine }, options(signal)),
    files: (request, onPage, signal) =>
      readAllPages(
        streams(signal),
        codeReviewFilesRef,
        {
          comparisonID: request.comparisonID,
          side: request.side,
          scope,
          ...(request.changedOnly ? { changedOnly: true } : {}),
        },
        "path",
        FILE_PAGE,
        onPage,
        signal,
      ),
    async task(taskID, signal) {
      const [row] = await readWindow(streams(signal), taskDetailRef, {
        filter: { scope: { kind: "project", sessionID: input.sessionID }, task: taskID },
        order: "task",
        window: 1,
      })
      if (!row) return undefined
      const body = (row.body ?? {}) as { title?: unknown }
      return {
        taskID,
        reference: String(row.reference ?? ""),
        title: typeof body.title === "string" ? body.title : "",
        planID: typeof row.plan_id === "string" ? row.plan_id : null,
        architectSessionID:
          typeof row.architect_session_id === "string" ? row.architect_session_id : null,
      }
    },
  }
}
