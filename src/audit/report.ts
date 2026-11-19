import { realpath, readFile } from "node:fs/promises"
import { AuditHistory } from "./history.ts"
import { fallowSection, type ReportSection } from "./wasm-analyzer.ts"
import type { AuditActor, AuditRun } from "./history.ts"

/** The five sections, in the order they are stored. */
const SECTIONS: readonly ReportSection[] = [
  "deadCode",
  "duplication",
  "health",
  "architecture",
  "featureFlags",
]
/** A whole-repository section on a large project takes far longer than a changed-file review. */
const SECTION_TIMEOUT_MS = 10 * 60_000

export type AuditRequest = {
  requestID: string
  workspace: string
  threads?: number
  taskID?: string
  phase?: AuditRun["phase"]
  baselineRunID?: string
}
async function result(history: AuditHistory, runID: string) {
  const output = history.summary(history.get(runID))
  try {
    await history.export(runID)
    return output
  } catch (error) {
    return { ...output, exportError: error instanceof Error ? error.message : String(error) }
  }
}
/** Persist each result before proceeding; worktree files are never the history authority. */
export async function fallowReport(
  history: AuditHistory,
  input: AuditRequest,
  actor: AuditActor,
  signal?: AbortSignal,
) {
  const start = history.start({ ...input, workspace: await realpath(input.workspace) }, actor)
  if (!start.created) return result(history, start.run.runID)
  const runID = start.run.runID
  try {
    const scope = { root: start.run.workspace, signal, timeoutMs: SECTION_TIMEOUT_MS }
    const scans = Object.fromEntries(
      SECTIONS.map((name) => [name, () => fallowSection(name, scope)]),
    )
    for (const [name, scan] of Object.entries(scans)) {
      signal?.throwIfAborted()
      let report: unknown, failure: string | undefined
      try {
        report = await scan()
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      history.section(runID, name, report, failure)
    }
    signal?.throwIfAborted()
    history.finish(runID)
  } catch (error) {
    history.finish(runID, error instanceof Error ? error.message : String(error))
    await result(history, runID)
    throw error
  }
  return result(history, runID)
}

export async function importAudit(
  history: AuditHistory,
  input: AuditRequest & { path: string },
  actor: AuditActor,
) {
  const source: unknown = JSON.parse(await readFile(input.path, "utf8"))
  if (
    !source ||
    typeof source !== "object" ||
    !("reports" in source) ||
    !source.reports ||
    typeof source.reports !== "object" ||
    Array.isArray(source.reports)
  )
    throw new Error("Expected a saved Fallow report with a reports object")
  const start = history.start(
    { ...input, phase: input.phase ?? "inspection", sourcePath: input.path },
    actor,
  )
  if (start.created) {
    // Imported metadata is provenance from the file, not a claim of current task ownership.
    const { reports, ...metadata } = source
    history.importedMetadata(start.run.runID, metadata)
    for (const [name, report] of Object.entries(reports)) {
      const error =
        report &&
        typeof report === "object" &&
        "error" in report &&
        typeof report.error === "string"
          ? report.error
          : undefined
      history.section(start.run.runID, name, report, error)
    }
    history.finish(start.run.runID)
  }
  return result(history, start.run.runID)
}
