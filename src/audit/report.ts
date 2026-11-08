import { mkdir, writeFile, realpath } from "node:fs/promises"
import { join } from "node:path"

/** Async native analysis runs on the host, never the Desktop renderer. */
export async function fallowReport(root: string, threads = 1, signal?: AbortSignal) {
  const workspace = await realpath(root)
  const startedAt = Date.now()
  const reportPath = join(workspace, "design", "audits", `${startedAt}-${crypto.randomUUID()}.json`)
  const fallow = await import("@fallow-cli/fallow-node")
  const options = { root: workspace, threads, explain: true }
  const scans = {
    deadCode: () => fallow.detectDeadCode(options),
    duplication: () => fallow.detectDuplication(options),
    health: () => fallow.computeHealth({ ...options, css: true }),
    architecture: () => fallow.detectArchitecture(options),
    featureFlags: () => fallow.detectFeatureFlags(options),
  }
  const reports: Record<string, unknown> = {}
  const analyses: Array<{ name: string; summary?: unknown; error?: string }> = []
  // Avoid competing full-repository scans; one worker thread keeps interactive work responsive.
  for (const [name, scan] of Object.entries(scans)) {
    signal?.throwIfAborted()
    try {
      const report = await scan()
      reports[name] = report
      analyses.push({
        name,
        summary:
          "summary" in report
            ? report.summary
            : "stats" in report
              ? report.stats
              : { totalFlags: report.total_flags },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reports[name] = { error: message }
      analyses.push({ name, error: message })
    }
  }
  const finishedAt = Date.now()
  await mkdir(join(workspace, "design", "audits"), { recursive: true })
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        source: "@fallow-cli/fallow-node",
        workspace,
        startedAt,
        finishedAt,
        reports,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  )
  return { reportPath, startedAt, finishedAt, analyses }
}
