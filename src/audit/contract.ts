import { z } from "zod"
const text = z.string().min(1)
const timestamp = z.int().nonnegative()
const AuditPhase = z.enum(["baseline", "follow-up", "inspection"])
const AuditRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runID: z.uuid(),
  projectDirectory: text,
  workspace: text,
  taskID: z.uuid().nullable(),
  planID: z.uuid().nullable(),
  attemptID: z.uuid().nullable(),
  sessionID: text,
  agent: text,
  requestID: text,
  phase: AuditPhase,
  baselineRunID: z.uuid().nullable(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  state: z.enum(["collecting", "completed", "partial", "interrupted"]),
  source: z.enum(["fallow", "legacy-file"]),
  sourcePath: text.nullable(),
  error: z.string().nullable(),
  requestInput: z.string(),
  importedMetadata: z.unknown().optional(),
})
export type AuditRun = z.infer<typeof AuditRunSchema>
const AuditSummary = AuditRunSchema.omit({ requestInput: true }).extend({
  reportPath: text,
  analyses: z.array(
    z.strictObject({
      name: text,
      summary: z.unknown(),
      error: z.string().nullable(),
      findingCount: z.int().nonnegative(),
      capturedAt: timestamp,
    }),
  ),
})
export const AuditScanOutput = AuditSummary.extend({ exportError: z.string().optional() })
export const AuditDecisionInput = z.strictObject({
  requestID: text,
  runID: z.uuid(),
  findingID: text,
  disposition: z.enum(["open", "fixed", "retained", "false-positive", "deferred"]),
  note: text,
  followupRunID: z.uuid().optional(),
})
export type AuditDecision = z.infer<typeof AuditDecisionInput>
export const AuditDecisionRecord = AuditDecisionInput.extend({
  agent: text,
  sessionID: text,
  createdAt: timestamp,
})
export const AuditQueryOutput = z.strictObject({
  runs: z.array(AuditSummary),
  nextOffset: z.int().nonnegative().nullable(),
})
export const AuditDetailOutput = z.strictObject({
  run: AuditSummary,
  findings: z.array(
    z.strictObject({
      findingID: text,
      analysis: text,
      category: text,
      path: z.string().nullable(),
      line: z.number().nullable(),
      observedAt: timestamp,
      details: z.unknown(),
      decisions: z.array(AuditDecisionRecord),
    }),
  ),
  totalFindings: z.int().nonnegative(),
  nextOffset: z.int().nonnegative().nullable(),
  reports: z.record(z.string(), z.unknown()).optional(),
})
