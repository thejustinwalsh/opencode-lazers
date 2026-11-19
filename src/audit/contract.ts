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

const Thresholds = z.strictObject({
  cyclomatic: z.int().positive(),
  cognitive: z.int().positive(),
})
const FindingSchema = z.strictObject({
  id: text,
  check: z.enum(["duplication", "complexity", "dead-code", "cycle"]),
  status: z.enum(["introduced", "worsened"]),
  file: text,
  line: z.int().nonnegative(),
  endLine: z.int().nonnegative().optional(),
  subject: text,
  measured: z.number().optional(),
  limit: z.number().optional(),
  before: z.number().optional(),
  others: z
    .array(
      z.strictObject({ file: text, line: z.int().nonnegative(), endLine: z.int().nonnegative() }),
    )
    .optional(),
  fix: text,
})
export const FallowCheckOutput = z.strictObject({
  status: z.enum(["clean", "findings", "unavailable"]),
  introduced: z.array(FindingSchema),
  concerns: z.array(FindingSchema),
  thresholds: Thresholds,
})
export const FallowDupesOutput = z.strictObject({
  groups: z.array(
    z.strictObject({
      id: text,
      lines: z.int().nonnegative(),
      tokens: z.int().nonnegative(),
      instances: z
        .array(
          z.strictObject({
            file: text,
            startLine: z.int().nonnegative(),
            endLine: z.int().nonnegative(),
          }),
        )
        .max(5),
      moreInstances: z.int().nonnegative(),
    }),
  ),
  total: z.int().nonnegative(),
  duplicationPct: z.number(),
  nextOffset: z.int().nonnegative().nullable(),
})
export const FallowHealthOutput = z.strictObject({
  functions: z.array(
    z.strictObject({
      file: text,
      line: z.int().nonnegative(),
      name: text,
      cyclomatic: z.int().nonnegative(),
      cognitive: z.int().nonnegative(),
      lines: z.int().nonnegative(),
      exceeded: z.boolean(),
    }),
  ),
  total: z.int().nonnegative(),
  thresholds: Thresholds,
  nextOffset: z.int().nonnegative().nullable(),
})
export const FallowDeadCodeOutput = z.strictObject({
  findings: z.array(
    z.strictObject({
      id: text,
      kind: z.enum(["file", "export", "type", "dependency", "member"]),
      file: text,
      line: z.int().nonnegative(),
      name: text,
    }),
  ),
  total: z.int().nonnegative(),
  nextOffset: z.int().nonnegative().nullable(),
})
export const FallowConfigOutput = z.strictObject({
  source: z.enum(["repo", "lazers", "defaults"]),
  sha256: text.optional(),
  config: z.unknown().nullable(),
  deadCodeEnabled: z.boolean(),
  shadowedLazersConfig: z.boolean().optional(),
  missing: z.array(text).optional(),
  draft: z.unknown().optional(),
})
export const FallowConfigSetOutput = z.strictObject({
  sha256: text,
  config: z.unknown(),
  createdAt: timestamp,
})
