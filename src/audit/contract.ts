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
})

const Thresholds = z.strictObject({
  cyclomatic: z.int().positive(),
  cognitive: z.int().positive(),
})

/**
 * The one typed result of `fallow audit` for a change. The engine's report is validated
 * (`engine-audit.ts`), converted once (`audit-findings.ts`) and carried unchanged through the
 * check receipt, the repair prompt, the Architect notice and `lz-fallow-audit`; only
 * `fallow-render.ts` turns it into text. Names and enums follow Fallow's own JSON.
 */
const FallowSeverity = z.enum(["error", "warn"])
const FallowAttribution = z.enum(["introduced", "worsened", "inherited"])
const FallowClass = z.enum([
  "complexity",
  "duplication",
  "dead-code",
  "dependency",
  "architecture",
  "diff-risk",
  "styling",
])
const FallowMetric = z.enum(["cyclomatic", "cognitive", "crap", "line_count"])
const Location = z.strictObject({
  file: text,
  line: z.int().nonnegative(),
  endLine: z.int().nonnegative().optional(),
})
const FallowFinding = z.strictObject({
  /** Stable across edits (no line number), so the same finding is recognised after a repair. */
  id: text,
  /** The engine's rule name: `complexity`, `code-duplication`, `unused-export`, `weakened-tests`... */
  rule: text,
  class: FallowClass,
  /** `error` fails the audit, `warn` only warns; the engine's own gate decides, not LAZERS. */
  severity: FallowSeverity,
  attribution: FallowAttribution,
  file: text,
  line: z.int().nonnegative(),
  endLine: z.int().nonnegative().optional(),
  symbol: text.optional(),
  message: text,
  measures: z
    .array(
      z.strictObject({
        metric: FallowMetric,
        value: z.number(),
        baseValue: z.number().optional(),
        threshold: z.number().optional(),
      }),
    )
    .optional(),
  worsenedMetrics: z
    .array(z.strictObject({ metric: FallowMetric, base: z.number(), head: z.number() }))
    .optional(),
  gateExemption: z.literal("test-file").optional(),
  /** CRAP derived from static test reachability, not measured coverage; never gates. */
  estimatedCrap: z.literal(true).optional(),
  relatedLocations: z.array(Location).optional(),
  /** A `fallow-ignore` comment this finding is about: what it suppresses and the reason it gives. */
  suppression: z.strictObject({ kinds: z.array(text), reason: text.optional() }).optional(),
  suggestion: text.optional(),
  suppress: z.strictObject({ comment: text, requiresReason: z.literal(true) }).optional(),
  /** Plan review only: the task(s) whose own change touched this finding's file(s). */
  taskID: text.optional(),
  taskIDs: z.array(text).optional(),
})
export type FallowFinding = z.infer<typeof FallowFinding>

export const FallowPackage = z.strictObject({
  verdict: z.enum(["pass", "warn", "fail"]),
  base: text,
  head: text.optional(),
  config: z.strictObject({
    source: z.enum(["repo", "lazers"]),
    sha256: text.optional(),
    /** Classes the audit did not run, and why. Never presented as zero findings. */
    classesNotChecked: z.array(z.strictObject({ class: text, reason: text })),
  }),
  thresholds: Thresholds,
  findings: z.array(FallowFinding),
  summary: z.strictObject({
    errors: z.int().nonnegative(),
    warnings: z.int().nonnegative(),
    inherited: z.int().nonnegative(),
  }),
  baseSnapshotSkipped: z.literal(true).optional(),
  timings: z.strictObject({ elapsedMs: z.int().nonnegative() }),
})
export type FallowPackage = z.infer<typeof FallowPackage>

/** What became of a finding the first audit reported, read by auditing again after the repair. */
const FallowDisposition = z.strictObject({
  findingID: text,
  severity: FallowSeverity,
  disposition: z.enum(["fixed", "remaining", "suppressed"]),
  /** The reason text of a suppression comment the repair added. Absent when none was given. */
  reason: text.optional(),
})
export type FallowDisposition = z.infer<typeof FallowDisposition>

const FallowReviewOutput = z.strictObject({
  status: z.enum(["clean", "findings", "unavailable"]),
  reason: z.string().optional(),
  package: FallowPackage.optional(),
  dispositions: z.array(FallowDisposition).optional(),
})
export type FallowReviewOutput = z.infer<typeof FallowReviewOutput>
export const FallowCheckOutput = FallowReviewOutput

/** The Fallow field of a `task-accepted` outcome: what remains, and what the repair did about it. */
export const FallowAcceptance = z.strictObject({
  package: FallowPackage,
  dispositions: z.array(FallowDisposition).optional(),
})
export type FallowAcceptance = z.infer<typeof FallowAcceptance>

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
const ConfigSource = z.enum(["repo", "lazers"])
export const FallowConfigOutput = z.strictObject({
  /** False when the project has no config: nothing is audited until one is set. */
  resolved: z.boolean(),
  source: ConfigSource.optional(),
  sha256: text.optional(),
  config: z.unknown().nullable(),
  /** Who set the LAZERS config, when, and why. Absent for a repository config file. */
  setBy: z
    .strictObject({ agent: text, sessionID: text, at: timestamp, reason: z.string().optional() })
    .optional(),
  shadowedLazersConfig: z.boolean().optional(),
  missing: z.array(text).optional(),
})
export const FallowConfigSetOutput = z.strictObject({
  sha256: text,
  config: z.unknown(),
  createdAt: timestamp,
  reason: text,
})

/** A proposed config part with the evidence it rests on. */
export const FallowConfigSuggestOutput = z.strictObject({
  project: text,
  config: z.record(z.string(), z.unknown()),
  evidence: z.array(
    z.strictObject({
      part: text,
      value: z.unknown(),
      source: text,
      detail: text,
    }),
  ),
  /** What the engine detected: plugins, entry-point counts by source, workspaces. */
  detected: z.strictObject({
    plugins: z.array(text),
    entryPointSources: z.record(z.string(), z.int().nonnegative()),
    workspaces: z.array(text),
  }),
  next: text,
  /** The config runbook on a session's first suggest, the pointer to it after. */
  guidance: text.optional(),
})

/** A runbook returned on request: `lz-fallow-config` with mode guide. */
export const FallowConfigGuideOutput = z.strictObject({
  topic: z.enum(["config", "suppressions"]),
  guidance: text,
})

/** `lz-fallow-config` suggest or dry-run while the project's profile turns the audit off. */
export const FallowConfigAuditOffOutput = z.strictObject({
  refused: z.literal("PROFILE_AUDIT_OFF"),
  guidance: text,
})

export const FallowDryRunOutput = z.strictObject({
  project: text,
  /** Findings of the whole repository under the candidate, per class (not an audit of a change). */
  classes: z.array(
    z.strictObject({
      class: text,
      total: z.int().nonnegative(),
      sample: z.array(z.strictObject({ file: text, line: z.int().nonnegative(), subject: text })),
      /** How many findings the sample was drawn from, evenly spaced. */
      sampledFrom: z.int().nonnegative(),
    }),
  ),
  thresholds: Thresholds,
  next: text,
})

const Penalty = z.strictObject({
  /** `dead_files`, `dead_exports`, `complexity`, `p90_complexity`, `maintainability`, `hotspots`, `unused_deps`, `circular_deps`, `unit_size`, `coupling`, `duplication`. */
  metric: text,
  /** Points taken off 100 by this metric. */
  penalty: z.number(),
  /** The measured value behind it (percent, count or average, per the metric); null when not measured. */
  value: z.number().nullable(),
})
const HealthRow = z.strictObject({
  file: z.string(),
  line: z.int().nonnegative(),
  subject: z.string(),
})
const FallowHealthComparison = z.strictObject({
  baselineRunID: z.uuid(),
  scoreFrom: z.number().nullable(),
  scoreTo: z.number().nullable(),
  /** Positive when the score rose (the repository got healthier). */
  scoreDelta: z.number().nullable(),
  gradeFrom: z.string().nullable(),
  gradeTo: z.string().nullable(),
  penaltyDeltas: z.array(
    z.strictObject({
      metric: text,
      from: z.number(),
      to: z.number(),
      /** Positive when the penalty grew (this metric got worse). */
      delta: z.number(),
    }),
  ),
  /** False when one run left duplication out of its score, so that penalty is not comparable. */
  duplicationComparable: z.boolean(),
})
/** One whole-repository health run, from the durable audit history. */
export const FallowHealthRunOutput = z.strictObject({
  runID: z.uuid(),
  phase: z.enum(["baseline", "follow-up", "inspection"]),
  state: z.enum(["collecting", "completed", "partial", "interrupted"]),
  score: z.number().nullable(),
  grade: z.string().nullable(),
  formulaVersion: z.int().nullable(),
  /** Every penalty, worst first. */
  penalties: z.array(Penalty),
  duplicationIncluded: z.boolean(),
  /** Per penalised metric, the worst findings behind it (at most 5). */
  top: z.array(z.strictObject({ metric: text, penalty: z.number(), findings: z.array(HealthRow) })),
  comparison: FallowHealthComparison.optional(),
  errors: z.array(z.strictObject({ section: text, message: text })),
  reportPath: text,
})
export type FallowHealthRunOutput = z.infer<typeof FallowHealthRunOutput>
export type FallowHealthComparison = z.infer<typeof FallowHealthComparison>
