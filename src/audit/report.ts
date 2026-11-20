import { realpath, readFile } from "node:fs/promises"
import { AuditHistory } from "./history.ts"
import {
  cleanupResolvedFallowConfig,
  resolveCurrentFallowConfig,
  type ResolvedFallowConfig,
} from "./config.ts"
import {
  fallowCombined,
  fallowHealthWithoutDuplication,
  fallowSection,
  type ReportSection,
} from "./wasm-analyzer.ts"
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
  /** The sections to run; default all five. A health run is deadCode, duplication and health. */
  sections?: ReportSection[]
}

/** Why a section is absent from a run that fell back for a project too large to analyse whole. */
export const DUPLICATION_NOT_INCLUDED =
  "duplication not included: the project is too large for the duplication index, so the score uses the other metrics"

type SharedSection = "deadCode" | "duplication" | "health"
const SHARED: readonly SharedSection[] = ["deadCode", "duplication", "health"]

type Outcome = { report?: unknown; failure?: string }
/** The engine calls a report makes; tests inject failures (a project too large for the index). */
export type ReportRunners = {
  combined: typeof fallowCombined
  healthWithoutDuplication: typeof fallowHealthWithoutDuplication
  section: typeof fallowSection
}
const realRunners: ReportRunners = {
  combined: fallowCombined,
  healthWithoutDuplication: fallowHealthWithoutDuplication,
  section: fallowSection,
}

type Scope = {
  root: string
  signal?: AbortSignal
  timeoutMs: number
  priority: "background"
}

/**
 * Dead code, duplication and health in one engine run (the duplication report is computed once and
 * handed to health's score). When the project is too large for that run, each section runs alone
 * and health leaves duplication out of the score, with the reason recorded on the duplication
 * section instead of failing the report.
 */
async function sharedSections(
  wanted: readonly ReportSection[],
  scope: Scope,
  run: ReportRunners,
): Promise<Map<SharedSection, Outcome>> {
  const results = new Map<SharedSection, Outcome>()
  const names = SHARED.filter((name) => wanted.includes(name))
  if (names.length === 0) return results
  try {
    const combined = await run.combined(scope)
    for (const name of names) results.set(name, { report: combined[name] })
    return results
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("analyzer-memory")) throw error
  }
  for (const name of names) {
    try {
      const report =
        name === "health"
          ? await run.healthWithoutDuplication(scope)
          : name === "duplication"
            ? undefined
            : await run.section(name, scope)
      results.set(name, name === "duplication" ? { failure: DUPLICATION_NOT_INCLUDED } : { report })
    } catch (error) {
      results.set(name, { failure: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
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
  run: ReportRunners = realRunners,
) {
  const start = history.start({ ...input, workspace: await realpath(input.workspace) }, actor)
  if (!start.created) return result(history, start.run.runID)
  const runID = start.run.runID
  let resolved: ResolvedFallowConfig | undefined
  try {
    // The same config every Fallow entry point reads: repo file, else the stored LAZERS config,
    // else the config-required error (the run is then recorded as interrupted).
    resolved = await resolveCurrentFallowConfig({
      directory: start.run.workspace,
      repository: history.repository,
    })
    const scope = {
      root: start.run.workspace,
      ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
      signal,
      timeoutMs: SECTION_TIMEOUT_MS,
      // Whole-project reports run the longest: they yield to every other caller.
      priority: "background" as const,
    }
    const wanted = input.sections ?? SECTIONS
    const shared = await sharedSections(wanted, scope, run).catch((error: unknown) => {
      // A failure of the shared run is each shared section's failure, as a failed scan was.
      const failure = error instanceof Error ? error.message : String(error)
      return new Map<SharedSection, Outcome>(
        SHARED.filter((n) => wanted.includes(n)).map((n) => [n, { failure }]),
      )
    })
    for (const name of SECTIONS.filter((n) => wanted.includes(n))) {
      signal?.throwIfAborted()
      let report: unknown, failure: string | undefined
      const done = (shared as Map<ReportSection, Outcome>).get(name)
      if (done) ({ report, failure } = done)
      else {
        try {
          report = await run.section(name, scope)
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
      }
      history.section(runID, name, report, failure)
    }
    signal?.throwIfAborted()
    history.finish(runID)
  } catch (error) {
    history.finish(runID, error instanceof Error ? error.message : String(error))
    await result(history, runID)
    throw error
  } finally {
    if (resolved) await cleanupResolvedFallowConfig(resolved)
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
