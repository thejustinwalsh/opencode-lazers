import type { TaskRepository } from "../storage.ts"

export type AuditorReportInput = {
  /** Deterministic per attempt and phase, so a restart replays the stored run instead of rescanning. */
  requestID: string
  phase: "baseline" | "follow-up"
  workspace: string
  /** The attempt's session: the audit history links the run to the task and attempt through it. */
  sessionID: string
  repository: TaskRepository
}

export type AuditorReport = (input: AuditorReportInput) => Promise<unknown>

/** The durable five-section report, loaded on first use so a service that never audits skips it. */
export const defaultAuditorReport: AuditorReport = async (input) => {
  const [{ fallowReport }, { AuditHistory }] = await Promise.all([
    import("../audit/report.ts"),
    import("../audit/history.ts"),
  ])
  return fallowReport(
    new AuditHistory(input.repository),
    {
      requestID: input.requestID,
      workspace: input.workspace,
      phase: input.phase,
    },
    { sessionID: input.sessionID, agent: "auditor" },
  )
}
