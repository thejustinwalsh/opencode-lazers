import { TaskSourcePlanSchema } from "../task.ts"
import { Rpc } from "@opencode/plugin/rpc"
import { TaskState, DispatchPause } from "../runner/schema.ts"
import { ProjectRef } from "../projects/scope.ts"
import { z } from "zod"

const ObservationScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionID: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("project"), sessionID: z.string().min(1).max(200) }),
  /** Every project the caller may read, a page per checkout. `sessionID` is the caller. */
  z.strictObject({ kind: z.literal("all"), sessionID: z.string().min(1).max(200) }),
])

const ObservationScopeView = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionID: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("project") }),
  z.strictObject({ kind: z.literal("all") }),
])

/** The all-projects additions every output carries: the page's project and the next cursor. */
const AllPage = {
  project: ProjectRef.optional(),
  nextCursor: z.string().nullable().optional(),
}
const PageCursor = z.string().min(1).max(2048).optional()
/** A cursor pages the all-projects scope; it means nothing in the others. */
function cursorOnlyForAll(
  input: { scope: { kind: string }; cursor?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (input.cursor && input.scope.kind !== "all")
    ctx.addIssue({
      code: "custom",
      path: ["cursor"],
      message: "A cursor applies to the all-projects scope only",
    })
}

const Boundary = z.strictObject({
  repositoryVersion: z.int().nonnegative(),
  sourceRevision: z.int().nonnegative(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  nativeRevision: z.int().nonnegative(),
  eventSequence: z.int().nonnegative(),
  transitionSequence: z.int().nonnegative(),
})

const MachineTransition = z.strictObject({ event: z.string(), target: TaskState })
const MachineState = z.strictObject({
  id: TaskState,
  type: z.enum(["atomic", "final"]),
  transitions: z.array(MachineTransition),
})

const NodeSnapshot = z.strictObject({
  status: z.string(),
  value: TaskState,
})

const ObservationNode = z.strictObject({
  taskID: z.uuid(),
  reference: z.string().optional(),
  sourcePlan: TaskSourcePlanSchema.optional(),
  revision: z.literal(1),
  objective: z.string(),
  ordinal: z.int().nonnegative(),
  state: TaskState,
  version: z.int().positive(),
  reason: z.string().nullable(),
  machineVersion: z.string(),
  machineSupported: z.boolean(),
  snapshot: NodeSnapshot.nullable(),
  snapshotMatchesState: z.boolean(),
  waitingOn: z.array(z.uuid()),
})

const ObservationPlan = z.strictObject({
  /** Present in the all-projects scope only. */
  project: ProjectRef.optional(),
  dispatchPause: DispatchPause.optional(),
  priority: z.int().optional(),
  queuePosition: z.int().nonnegative().optional(),
  id: z.uuid(),
  revision: z.int().positive(),
  version: z.int().positive(),
  state: z.string(),
  reason: z.string().nullable(),
  title: z.string().max(120).nullable(),
  afterPlans: z.array(z.uuid()).max(1000),
  nodes: z.array(ObservationNode).max(100),
  dependencies: z.array(z.strictObject({ prerequisite: z.uuid(), successor: z.uuid() })).max(500),
})

const UnplannedTask = z.strictObject({
  /** Present in the all-projects scope only. */
  project: ProjectRef.optional(),
  taskID: z.uuid(),
  revision: z.literal(1),
  status: z.literal("submitted"),
  title: z.string().max(120),
})

const RecordedExecution = z.strictObject({
  startedAt: z.number().finite().nullable(),
  endedAt: z.number().finite().nullable(),
  startSequence: z.int().positive().nullable(),
  endSequence: z.int().positive().nullable(),
  timingBasis: z.string(),
})

const TimelineAttempt = z.strictObject({
  id: z.uuid(),
  planID: z.uuid(),
  taskID: z.uuid(),
  number: z.int().positive(),
  state: z.string(),
  startedAt: z.number().finite(),
  endedAt: z.null(),
  timingBasis: z.string(),
  executions: z.array(RecordedExecution),
})

const TimelineCheck = z.strictObject({
  id: z.string(),
  planID: z.uuid(),
  taskID: z.uuid().nullable(),
  attemptID: z.uuid().nullable(),
  checkID: z.string(),
  scope: z.enum(["attempt", "plan"]),
  state: z.string(),
  startedAt: z.number().finite().nullable(),
  endedAt: z.number().finite().nullable(),
  exitCode: z.number().finite().nullable(),
  timingBasis: z.string(),
})

const SnapshotInput = z
  .strictObject({ scope: ObservationScope, cursor: PageCursor })
  .superRefine(cursorOnlyForAll)
export const SnapshotOutput = z.strictObject({
  schemaVersion: z.literal(1),
  projectID: z.string().min(1),
  scope: ObservationScopeView,
  ...AllPage,
  observedAt: z.iso.datetime(),
  boundary: Boundary,
  machine: z.strictObject({
    id: z.string(),
    version: z.string(),
    initialState: TaskState,
    states: z.array(MachineState),
  }),
  plans: z.array(ObservationPlan).max(1000),
  unplannedTasks: z.array(UnplannedTask),
  attempts: z.array(TimelineAttempt).max(10_000),
  checks: z.array(TimelineCheck).max(10_000),
  coverage: z
    .strictObject({
      workTruncated: z.boolean(),
      transitionsTruncated: z.boolean(),
      attemptsTruncated: z.boolean(),
      checksTruncated: z.boolean(),
    })
    .optional(),
})

const ProgressDiagnosticsInput = z
  .strictObject({ scope: ObservationScope, cursor: PageCursor })
  .superRefine(cursorOnlyForAll)
const ProcessSchedulerTotals = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    scope: z.literal("process"),
    audience: z.literal("architect-only"),
    source: z.literal("sharedScheduler.snapshot"),
    implementation: z.literal("scheduler/v2"),
    generation: z.uuid(),
    timerCount: z.int().nonnegative(),
    groups: z.int().nonnegative(),
    participants: z.int().nonnegative(),
    running: z.int().nonnegative(),
    runs: z.int().nonnegative(),
    errors: z.int().nonnegative(),
    wakeups: z.int().nonnegative(),
  }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("architect-only") }),
])
const ProgressDiagnosticsOutput = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.union([
    z.strictObject({ kind: z.literal("project") }),
    z.strictObject({ kind: z.literal("all") }),
  ]),
  ...AllPage,
  observedAt: z.number().finite(),
  implementationID: z.string().min(1).max(80),
  moduleGenerationID: z.uuid(),
  state: z.enum(["absent", "uninitialized", "initialized", "instrumentation-unavailable"]),
  coverage: z.enum(["not-started", "complete", "partial"]),
  coordinator: z.strictObject({
    participantCount: z.int().nonnegative(),
    participantGenerations: z
      .array(
        z.strictObject({
          generationID: z.uuid().nullable(),
          participantCount: z.int().positive(),
        }),
      )
      .max(32),
    participantGenerationsTruncated: z.boolean(),
    locationCount: z.int().nonnegative(),
    locationParticipantCounts: z.array(z.int().positive()).max(32),
    unknownLocationParticipantCount: z.int().nonnegative(),
    locationsTruncated: z.boolean(),
    assignments: z.strictObject({
      baselineCaptured: z.boolean(),
      cachedCount: z.int().nonnegative(),
      activeCount: z.int().nonnegative(),
      terminalCount: z.int().nonnegative(),
      asOf: z.number().finite().nullable(),
    }),
    work: z.strictObject({
      queuedCount: z.int().nonnegative(),
      delayedCount: z.int().nonnegative(),
      dirtyCount: z.int().nonnegative(),
      drainOwned: z.boolean(),
      reconstructionActive: z.boolean(),
      timerScheduled: z.boolean(),
      outstandingRetiredReads: z.int().nonnegative(),
    }),
    nativeReads: z
      .strictObject({
        startedAt: z.number().finite(),
        get: z.strictObject({
          invocations: z.int().nonnegative(),
          succeeded: z.int().nonnegative(),
          failed: z.int().nonnegative(),
          pending: z.int().nonnegative(),
        }),
        context: z.strictObject({
          invocations: z.int().nonnegative(),
          succeeded: z.int().nonnegative(),
          failed: z.int().nonnegative(),
          pending: z.int().nonnegative(),
        }),
      })
      .nullable(),
  }),
  processSchedulerTotals: ProcessSchedulerTotals,
})

const LiveRoute = z.strictObject({
  id: z.string().min(1).max(512),
  providerID: z.string().min(1).max(200),
  modelID: z.string().min(1).max(300),
  variant: z.string().max(200).nullable(),
  source: z.enum(["attempt-policy", "session-selection", "step-event"]),
  sessionID: z.string().min(1).max(200),
  attemptID: z.uuid().nullable(),
  messageID: z.string().max(200).nullable(),
  eventID: z.string().max(200).nullable(),
  observedAt: z.number().finite().nullable(),
})

const LiveAssignment = z.strictObject({
  planID: z.uuid(),
  taskID: z.uuid(),
  attemptID: z.uuid(),
  state: z.enum(["preparing", "running", "verifying"]),
  startedAt: z.number().finite(),
  /** Additive: absent when the read cannot supply it. */
  attemptNumber: z.int().positive().optional(),
  taskTitle: z.string().min(1).max(240).optional(),
  taskReference: z.string().min(1).max(60).optional(),
  /** Additive: the task node and plan state, so every panel names a held worker the same way. */
  task: z
    .strictObject({
      state: z.string().min(1).max(40),
      reason: z.string().max(600).nullable(),
      planState: z.string().min(1).max(40),
      planReason: z.string().max(600).nullable(),
    })
    .optional(),
})

const LiveSession = z.strictObject({
  id: z.string().min(1).max(512),
  sessionID: z.string().min(1).max(200),
  projectID: z.string().min(1).max(200),
  classification: z.enum(["managed", "unmanaged"]),
  /** Additive: the native parent session, only when it has one. */
  parentSessionID: z.string().min(1).max(200).optional(),
  /** Additive: the native session title, when the session has one. */
  title: z.string().min(1).max(200).optional(),
  isViewSession: z.boolean(),
  isCurrentArchitect: z.boolean().nullable(),
  availability: z.enum(["available", "missing", "archived", "moved", "unavailable"]),
  freshness: z.enum(["current", "stale", "unknown"]),
  agent: z.string().max(200).nullable(),
  state: z.enum(["busy", "idle", "unknown"]),
  assignment: LiveAssignment.nullable(),
  selectedRouteID: z.string().max(512).nullable(),
  configuredRouteID: z.string().max(512).nullable(),
  observedRouteID: z.string().max(512).nullable(),
  routeCoverage: z.strictObject({
    selected: z.enum(["available", "unavailable", "truncated"]),
    configured: z.enum(["available", "unavailable", "not-assigned", "truncated"]),
    observed: z.enum(["available", "not-observed", "identity-unavailable", "truncated"]),
  }),
  updatedAt: z.number().finite().nullable(),
  observedAt: z.number().finite().nullable(),
})

const LiveToolCall = z.strictObject({
  id: z.string().min(1).max(512),
  sessionID: z.string().min(1).max(200),
  /** Null for a session with no runner assignment, such as the Architect. */
  attemptID: z.uuid().nullable(),
  messageID: z.string().max(200).nullable(),
  callID: z.string().min(1).max(200),
  tool: z.string().max(160).nullable(),
  status: z.enum(["input-started", "running", "not-executed", "succeeded", "failed", "unknown"]),
  execution: z.enum(["executed", "not-executed", "unknown"]).nullable(),
  inputAt: z.number().finite().nullable(),
  calledAt: z.number().finite().nullable(),
  completedAt: z.number().finite().nullable(),
  observedAt: z.number().finite().nullable(),
  sourceProgressSequence: z.int().positive().nullable(),
  sourceEventID: z.string().max(200).nullable(),
  sourceEventType: z.string().max(120).nullable(),
  result: z.string().max(240).nullable(),
  error: z.string().max(240).nullable(),
  payloadAvailable: z.boolean(),
  fileTargets: z
    .strictObject({
      coverage: z.enum(["observed", "partial", "omitted"]),
      operation: z.enum(["read", "edit", "patch"]).nullable(),
      paths: z.array(z.string().max(512)).max(8),
    })
    .optional(),
  /** Additive: a redacted one-line summary of what the call ran, such as its command or file. */
  detail: z.string().max(200).optional(),
})

const LiveFlow = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(["execution", "model-request", "model-stream", "model-response", "tool-phase"]),
  source: z.enum(["progress", "native-event"]),
  from: z.string().max(512).nullable(),
  to: z.string().max(512).nullable(),
  sessionID: z.string().min(1).max(200),
  messageID: z.string().max(200).nullable(),
  callID: z.string().max(200).nullable(),
  tool: z.string().max(160).nullable(),
  agent: z.string().max(200).nullable(),
  routeID: z.string().max(512).nullable(),
  toolID: z.string().max(512).nullable(),
  status: z.string().min(1).max(32),
  startedAt: z.number().finite().nullable(),
  observedAt: z.number().finite(),
  sourceProgressSequence: z.int().positive().nullable(),
  sourceNativeRevision: z.int().positive().nullable(),
  sourceEventID: z.string().max(200).nullable(),
  sourceEventType: z.string().max(120).nullable(),
  /** Additive: the call summary for tool phases, when one was recorded. */
  detail: z.string().max(200).optional(),
  /** Additive: measured tokens of the finished model step, only when the step recorded them. */
  usage: z
    .strictObject({
      input: z.int().nonnegative().nullable(),
      output: z.int().nonnegative().nullable(),
    })
    .optional(),
})

export const LiveRadarInput = z
  .strictObject({
    scope: ObservationScope,
    includeUnmanagedSessions: z.boolean().default(false),
    cursor: PageCursor,
  })
  .superRefine(cursorOnlyForAll)
export const LiveRadarOutput = z.strictObject({
  schemaVersion: z.literal(1),
  projectID: z.string().min(1).max(200),
  scope: ObservationScopeView,
  ...AllPage,
  streamEpoch: z.uuid(),
  observedAt: z.number().finite(),
  boundary: z.strictObject({
    runnerRevision: z.int().nonnegative().nullable(),
    nativeRevision: z.int().nonnegative(),
    eventSequence: z.int().nonnegative(),
  }),
  freshness: z.strictObject({
    runner: z.enum(["current", "unavailable"]),
    nativeInventory: z.enum(["complete", "bounded", "unavailable"]),
    nativeEvents: z.enum(["connected", "gap-or-unavailable"]),
  }),
  scheduler: z.strictObject({
    status: z.enum(["scheduled", "draining", "registered", "absent", "stale", "unknown"]),
    participants: z.int().nonnegative().nullable(),
  }),
  /** Additive: recorded task counts in open plans; absent when the runner tables cannot be read. */
  workload: z
    .strictObject({
      queued: z.int().nonnegative(),
      needsYou: z.int().nonnegative(),
      failed: z.int().nonnegative(),
    })
    .optional(),
  coverage: z.strictObject({
    sessionCount: z.int().nonnegative(),
    managedSessionCount: z.int().nonnegative(),
    includeUnmanagedSessions: z.boolean(),
    inventoryTruncated: z.boolean(),
    assignmentTruncated: z.boolean(),
    progressTruncated: z.boolean(),
    payloadTruncated: z.boolean(),
    routeTruncated: z.boolean(),
    callsTruncated: z.boolean(),
    flowTruncated: z.boolean(),
    journalTruncated: z.boolean(),
    journal: z.enum(["available", "legacy-or-unavailable", "unavailable"]),
    foreignSessionsExcluded: z.int().nonnegative(),
    sourceQueries: z.int().nonnegative(),
    sourceRowsRead: z.int().nonnegative(),
    sourceBytesRead: z.int().nonnegative(),
    sourcePayloadBytesRead: z.int().nonnegative(),
    nativeInventoryReads: z.int().nonnegative(),
    nativeSessionReads: z.int().nonnegative(),
    nativeMetadataBytesInspected: z.int().nonnegative(),
    nativeMetadataTruncated: z.boolean(),
    nativeMetadataBoundary: z.literal("raw-selected-fields-after-adapter"),
    nativeContextLoads: z.literal(0),
    retainedStateEntries: z.int().nonnegative(),
    retainedStateTruncated: z.boolean(),
    responseBytes: z.int().nonnegative(),
  }),
  limits: z.strictObject({
    sessions: z.literal(32),
    inventoryCandidates: z.literal(256),
    progressRowsPerSession: z.literal(17),
    toolRowsPerSession: z.literal(17),
    progressRowsPerAttempt: z.literal(50),
    journalFacts: z.literal(257),
    journalHydrationFacts: z.literal(16),
    progressPayloadBytes: z.literal(4096),
    sourceRows: z.literal(1500),
    sourceBytes: z.literal(10_000_000),
    sourceQueries: z.literal(100),
    nativeMetadataBytes: z.literal(256_000),
    nativeSessionReads: z.literal(32),
    retainedStateEntries: z.literal(32),
    responseBytes: z.literal(512_000),
    nativeInventoryReads: z.literal(1),
  }),
  sessions: z.array(LiveSession).max(32),
  routes: z.array(LiveRoute).max(256),
  calls: z.array(LiveToolCall).max(256),
  flow: z.array(LiveFlow).max(256),
})

export const ObservabilityChanged = z.strictObject({
  projectID: z.string().min(1),
  sequence: z.int().positive(),
  repositoryVersion: z.int().nonnegative(),
  sourceRevision: z.int().nonnegative(),
  nativeRevision: z.int().nonnegative(),
  cause: z.enum(["runner", "native", "gap"]),
  resnapshotRequired: z.boolean(),
})

export const Observability = Rpc.define({
  id: "lazers.observability",
  methods: {
    snapshot: { input: SnapshotInput, output: SnapshotOutput },
    progressDiagnostics: {
      input: ProgressDiagnosticsInput,
      output: ProgressDiagnosticsOutput,
    },
    liveRadar: { input: LiveRadarInput, output: LiveRadarOutput },
  },
  events: { changed: { schema: ObservabilityChanged } },
})

export type ObservationScope = z.infer<typeof ObservationScope>
/** The scopes that read one project; every read except the all-projects ones takes this. */
export type SingleScope = Exclude<ObservationScope, { kind: "all" }>
const ALL_PROJECTS_UNAVAILABLE = "All-projects scope is not available for this read"
export function singleScope(scope: ObservationScope): SingleScope {
  if (scope.kind === "all") throw new Error(ALL_PROJECTS_UNAVAILABLE)
  return scope
}
export type ObservationScopeView = z.infer<typeof ObservationScopeView>
export type SnapshotResponse = z.infer<typeof SnapshotOutput>
export type LiveRadarRequestInput = z.input<typeof LiveRadarInput>
export type LiveRadarResponse = z.infer<typeof LiveRadarOutput>
export type ObservationChange = z.infer<typeof ObservabilityChanged>
