import { z } from "zod"
import {
  TaskClassificationProvenance,
  TaskClassificationRevision,
  TaskKindV1,
} from "../task-classification.ts"

export const OBSERVATION_LEDGER_TASK_KINDS = [
  "bug-repair",
  "feature-implementation",
  "refactoring",
  "testing",
  "documentation",
  "maintenance",
] as const

export const OBSERVATION_LEDGER_CATALOG = "task-kind/v1" as const

const TaskKind = TaskKindV1
const Route = z.strictObject({
  providerID: z.string().min(1).max(512),
  modelID: z.string().min(1).max(512),
  variant: z.string().max(512).nullable(),
})

export const ObservationLedgerReadInputSchema = z.strictObject({
  taskKind: TaskKind.nullable().optional(),
  cursor: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
export type ObservationLedgerReadInput = z.input<typeof ObservationLedgerReadInputSchema>

const ClassificationSchema = z.strictObject({
  catalog: z.literal(OBSERVATION_LEDGER_CATALOG),
  kind: TaskKind.nullable(),
  revision: z.number().int().nonnegative().nullable(),
  provenance: TaskClassificationProvenance.nullable(),
  history: z.array(TaskClassificationRevision),
  status: z.enum(["available", "unavailable"]),
})

const RouteSelectionSchema = z.strictObject({
  route: Route.nullable(),
  status: z.enum(["explicit", "inherited", "recorded", "unavailable"]),
  source: z.string().max(160).nullable(),
})

const RouteOccurrenceSchema = z.strictObject({
  occurrenceID: z.string().min(1).max(512),
  attemptID: z.string().min(1).max(2048),
  sessionID: z.string().min(1).max(2048),
  messageID: z.string().max(2048).nullable(),
  eventID: z.string().max(2048).nullable(),
  source: z.string().max(160),
  sourceType: z.string().max(160),
  observedAt: z.number().int().nullable(),
  route: Route.nullable(),
  identityStatus: z.enum(["exact", "unavailable"]),
})

const RouteObservationsSchema = z.strictObject({
  status: z.enum(["none", "single-route", "mixed-routes", "unavailable"]),
  coverage: z.enum(["complete", "truncated"]),
  route: Route.nullable(),
  distinctRoutes: z.array(Route),
  occurrences: z.array(RouteOccurrenceSchema),
  omittedOccurrenceCount: z.number().int().nonnegative(),
  attribution: z.enum([
    "unknown",
    "observed-route-does-not-prove-session-usage-attribution",
    "ambiguous-mixed-routes",
    "incomplete-truncated-route-observations",
  ]),
})

const UsageCategorySchema = z.strictObject({
  value: z.number().finite().nonnegative().nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable", "ambiguous"]),
  basis: z.enum([
    "native-session-cumulative-snapshot",
    "retained-progress-cumulative-snapshot",
    "retained-progress-additive-steps",
    "mixed",
    "unavailable",
  ]),
  valueScope: z.enum([
    "selected-cumulative-snapshot",
    "retained-additive-subtotal",
    "observed-subtotal",
    "unknown",
  ]),
  source: z.string().max(160).nullable(),
  observedAt: z.number().int().nullable(),
  recordedAt: z.number().int().nullable(),
  observationCount: z.number().int().nonnegative(),
  missingObservations: z.number().int().nonnegative(),
})

const UsageCategoriesSchema = z.strictObject({
  uncachedInput: UsageCategorySchema,
  output: UsageCategorySchema,
  reasoning: UsageCategorySchema,
  cacheRead: UsageCategorySchema,
  cacheWrite: UsageCategorySchema,
})

const TotalTokensSchema = z.strictObject({
  value: z.number().finite().nonnegative().nullable(),
  observedSubtotal: z.number().finite().nonnegative().nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable", "ambiguous"]),
  valueScope: z.enum(["selected-session-categories", "observed-subtotal", "unknown"]),
  basis: z.literal("sum-of-categorized-session-usage; legacy attempt scalars are not added"),
  unallocatedSessionIDs: z.array(z.string().min(1).max(2048)),
})

const AttemptSchema = z.strictObject({
  id: z.string().min(1).max(2048),
  planID: z.string().min(1).max(2048),
  number: z.number().int().positive(),
  state: z.string().min(1).max(160),
  sessionID: z.string().min(1).max(2048),
  messageID: z.string().min(1).max(2048),
  startedAt: z.number().int(),
  artifact: z.string().max(2048).nullable(),
  legacyTokenCount: z.number().finite().nonnegative().nullable(),
  legacyTokenStatus: z.enum(["missing", "retained-not-added"]),
  toolCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  nativeReportedCostUSD: z.number().finite().nonnegative().nullable(),
  requestedRoute: RouteSelectionSchema,
  frozenRoute: RouteSelectionSchema,
  observedRoutes: RouteObservationsSchema,
  persona: z.strictObject({
    requested: z.enum(["ui", "systems", "small-refactoring"]).nullable(),
    frozen: z.enum(["ui", "systems", "small-refactoring"]).nullable(),
    status: z.enum(["not-assigned", "match", "mismatch", "frozen-unavailable"]),
  }),
})

const ProgressObservationSchema = z.strictObject({
  occurrenceID: z.string().min(1).max(512),
  source: z.string().max(160),
  eventID: z.string().max(2048).nullable(),
  eventType: z.string().max(160),
  observedAt: z.number().int().nullable(),
  status: z.string().max(160).nullable(),
  messageID: z.string().max(2048).nullable(),
  callID: z.string().max(2048).nullable(),
  route: Route.nullable(),
  routeStatus: z.enum(["not-observed", "exact", "unavailable"]),
  identityStatus: z.enum(["exact", "unavailable"]),
})

const ProgressFactSchema = z.strictObject({
  id: z.string().min(1).max(512),
  sequence: z.number().int().positive(),
  attemptID: z.string().min(1).max(2048),
  sessionID: z.string().min(1).max(2048),
  messageID: z.string().max(2048).nullable(),
  callID: z.string().max(2048).nullable(),
  source: z.string().max(160),
  sources: z.array(z.string().max(160)),
  eventIDs: z.array(z.string().max(2048)),
  kind: z.string().max(160),
  at: z.number().int(),
  recordedAt: z.number().int().nullable(),
  measurementBasis: z.string().max(160).nullable(),
  usage: z
    .strictObject({
      input: z.number().finite().nonnegative().nullable(),
      output: z.number().finite().nonnegative().nullable(),
      reasoning: z.number().finite().nonnegative().nullable(),
      cacheRead: z.number().finite().nonnegative().nullable(),
      cacheWrite: z.number().finite().nonnegative().nullable(),
      costUSD: z.number().finite().nonnegative().nullable(),
    })
    .nullable(),
  route: Route.nullable(),
  routeStatus: z.enum(["not-observed", "exact", "unavailable"]),
  observations: z.array(ProgressObservationSchema),
  observationCoverage: z.enum(["complete", "truncated"]),
  omittedObservationCount: z.number().int().nonnegative(),
})

const ExecutionSchema = z.strictObject({
  planID: z.string().min(1).max(2048),
  planState: z.string().max(160),
  nodeState: z.string().max(160),
  artifact: z.string().max(2048).nullable(),
  attemptIDs: z.array(z.string().min(1).max(2048)),
})

const AcceptanceEvidenceSchema = z.strictObject({
  kind: z.enum(["accept", "adopt-accept"]),
  planID: z.string().min(1).max(2048),
  transitionID: z.number().int().positive(),
  artifactEventID: z.number().int().positive().nullable(),
  adoptionID: z.string().min(1).max(2048).nullable(),
  attemptID: z.string().min(1).max(2048).nullable(),
  artifact: z.string().min(1).max(2048),
  acceptedAt: z.number().int(),
})

const DispositionSchema = z.strictObject({
  id: z.number().int().positive(),
  requestID: z.string().max(200),
  disposition: z.enum(["superseded", "rejected", "duplicate", "fulfilled", "unknown"]),
  reason: z.string().max(2000),
  evidence: z
    .array(
      z.strictObject({
        kind: z.enum(["verification", "artifact", "human"]),
        reference: z.string().max(2000),
      }),
    )
    .max(20),
  relatedTaskIDs: z.array(z.string().min(1).max(2048)),
  sessionID: z.string().max(2048),
  agent: z.string().max(200),
  createdAt: z.string().max(64),
})

const AdoptionSchema = z.strictObject({
  id: z.string().min(1).max(2048),
  attemptID: z.string().min(1).max(2048),
  state: z.string().max(160),
  attemptState: z.string().max(160),
  oldArtifact: z.string().max(2048),
  descendantCommit: z.string().max(2048),
  combinedArtifact: z.string().max(2048),
  reason: z.string().max(2000),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})

const TransitionSchema = z.strictObject({
  id: z.number().int().positive(),
  planID: z.string().min(1).max(2048),
  event: z.string().max(160),
  at: z.number().int(),
  attemptID: z.string().min(1).max(2048).nullable(),
  from: z.string().max(160).nullable(),
  to: z.string().max(160).nullable(),
  reason: z.string().max(2000).nullable(),
})

const TaskSchema = z.strictObject({
  taskID: z.string().min(1).max(2048),
  taskReference: z.string().max(64).nullable(),
  submittedStatus: z.string().max(80).nullable(),
  createdAt: z.string().max(64),
  classification: ClassificationSchema,
  logicalOutcome: z.strictObject({
    accepted: z.boolean(),
    acceptedAt: z.number().int().nullable(),
    acceptedTaskCount: z.literal(1).or(z.literal(0)),
    evidence: z.array(AcceptanceEvidenceSchema),
  }),
  executions: z.array(ExecutionSchema),
  attempts: z.array(AttemptSchema),
  sessionIDs: z.array(z.string().min(1).max(2048)),
  progressFacts: z.array(ProgressFactSchema),
  usage: z.strictObject({ categories: UsageCategoriesSchema, totalTokens: TotalTokensSchema }),
  dispositions: z.array(DispositionSchema),
  adoptions: z.array(AdoptionSchema),
  transitions: z.array(TransitionSchema),
})

const SessionContributionSchema = z.strictObject({
  sessionID: z.string().min(1).max(2048),
  pageAnchorTaskID: z.string().min(1).max(2048),
  taskIDs: z.array(z.string().min(1).max(2048)),
  attemptIDs: z.array(z.string().min(1).max(2048)),
  allocation: z.enum(["one-logical-task", "ambiguous-shared-logical-tasks"]),
  categories: UsageCategoriesSchema,
  totalTokens: TotalTokensSchema,
  observedRoutes: RouteObservationsSchema,
})

const SourceSchema = z.strictObject({
  name: z.string().min(1).max(160),
  status: z.enum(["available", "missing-table", "missing-columns", "legacy-absent", "unavailable"]),
  missingColumns: z.array(z.string().max(160)),
})

export const ObservationLedgerOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(["available", "partial", "incomplete", "unavailable"]),
  scope: z.strictObject({ projectDirectory: z.string().min(1).max(8192) }),
  filters: z.strictObject({ taskKind: TaskKind.nullable() }),
  taskKindCatalog: z.strictObject({
    id: z.literal(OBSERVATION_LEDGER_CATALOG),
    kinds: z.array(TaskKind).length(6),
  }),
  pin: z
    .strictObject({
      snapshotID: z.string().uuid(),
      sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      capturedAt: z.number().int().nonnegative(),
      completeness: z.enum(["complete", "partial"]),
    })
    .nullable(),
  completeness: z.strictObject({
    status: z.enum(["complete", "partial", "incomplete", "unavailable"]),
    reasons: z.array(z.string().max(500)),
    sources: z.array(SourceSchema),
  }),
  classificationCoverage: z.strictObject({
    classifiedTaskCount: z.number().int().nonnegative().nullable(),
    unclassifiedTaskCount: z.number().int().nonnegative().nullable(),
    unavailableTaskCount: z.number().int().nonnegative().nullable(),
    excludedTaskCount: z.number().int().nonnegative().nullable(),
    totalTaskCount: z.number().int().nonnegative().nullable(),
  }),
  page: z.strictObject({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    returnedTaskCount: z.number().int().nonnegative(),
    totalTaskCount: z.number().int().nonnegative().nullable(),
    totalSessionContributionCount: z.number().int().nonnegative().nullable(),
  }),
  tasks: z.array(TaskSchema).max(100),
  sessionContributions: z.array(SessionContributionSchema),
  nextCursor: z.string().max(8192).nullable(),
  unavailableReason: z
    .enum(["database-missing", "database-unavailable", "task-table-missing"])
    .nullable(),
})

export type ObservationLedgerOutput = z.infer<typeof ObservationLedgerOutputSchema>
