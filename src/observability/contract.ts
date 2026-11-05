import { Rpc } from "@opencode/plugin/rpc"
import { TaskState } from "../runner/schema.ts"
import { z } from "zod"

export const ObservationScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionID: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("project"), sessionID: z.string().min(1).max(200) }),
])

export const ObservationScopeView = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionID: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("project") }),
])

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
  taskID: z.uuid(),
  revision: z.literal(1),
  status: z.literal("submitted"),
  title: z.string().max(120),
})

const RecordedTransition = z.strictObject({
  sequence: z.int().positive(),
  planID: z.uuid(),
  taskID: z.uuid().nullable(),
  attemptID: z.uuid().nullable(),
  planVersion: z.int().positive(),
  kind: z.enum(["machine", "runtime"]),
  event: z.string().max(120),
  from: TaskState.nullable(),
  to: TaskState.nullable(),
  reason: z.string().nullable(),
  recordedAt: z.number().finite(),
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

export const SnapshotInput = z.strictObject({ scope: ObservationScope })
export const SnapshotOutput = z.strictObject({
  schemaVersion: z.literal(1),
  projectID: z.string().min(1),
  scope: ObservationScopeView,
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
  transitions: z.array(RecordedTransition).max(10_000),
  attempts: z.array(TimelineAttempt).max(10_000),
  checks: z.array(TimelineCheck).max(10_000),
})

export const ProgressDiagnosticsInput = z.strictObject({ scope: ObservationScope })
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
export const ProgressDiagnosticsOutput = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.strictObject({ kind: z.literal("project") }),
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

const RadarRoute = z.strictObject({
  id: z.string().min(1).max(512),
  providerID: z.string().min(1).max(200),
  modelID: z.string().min(1).max(300),
  variant: z.string().max(200).nullable(),
  source: z.enum(["attempt-policy", "session-selection", "step-event"]),
  sessionID: z.string().max(200).nullable(),
  attemptID: z.uuid().nullable(),
  messageID: z.string().max(200).nullable(),
  eventID: z.string().max(200).nullable(),
  observedAt: z.number().finite().nullable(),
})

const RadarSession = z.strictObject({
  id: z.string().min(1).max(512),
  sessionID: z.string().min(1).max(200),
  projectID: z.string().min(1).max(200),
  parentSessionID: z.string().max(200).nullable(),
  classification: z.enum(["managed", "associated", "unmanaged"]),
  associations: z
    .array(
      z.enum([
        "attempt",
        "continuation",
        "plan-owner",
        "task-submitter",
        "scope-anchor",
        "native-ancestry",
      ]),
    )
    .max(20),
  availability: z.enum(["available", "missing", "archived", "moved", "unavailable"]),
  freshness: z.enum(["current", "stale", "unknown"]),
  agent: z.string().max(200).nullable(),
  state: z.enum(["busy", "idle", "unknown"]),
  currentRouteID: z.string().max(512).nullable(),
  configuredRouteIDs: z.array(z.string().max(512)).max(100),
  planIDs: z.array(z.uuid()).max(100),
  taskIDs: z.array(z.uuid()).max(100),
  attemptIDs: z.array(z.uuid()).max(100),
  updatedAt: z.number().finite().nullable(),
  observedAt: z.number().finite().nullable(),
})

const RadarEvidence = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("native-event"),
    eventID: z.string().min(1).max(200),
    eventType: z.string().min(1).max(120),
    sessionID: z.string().min(1).max(200),
    messageID: z.string().max(200).nullable(),
    callID: z.string().max(200).nullable(),
    at: z.number().finite(),
  }),
  z.strictObject({
    source: z.literal("runner-transition"),
    sequence: z.int().positive(),
    event: z.string().min(1).max(120),
    effectID: z.string().max(200).nullable(),
    outboxID: z.string().max(200).nullable(),
    messageID: z.string().max(200).nullable(),
    at: z.number().finite(),
  }),
  z.strictObject({
    source: z.literal("runner-record"),
    recordID: z.string().min(1).max(200),
    messageID: z.string().max(200).nullable(),
    callID: z.string().max(200).nullable(),
    at: z.number().finite().nullable(),
  }),
  z.strictObject({
    source: z.literal("native-read"),
    sessionID: z.string().min(1).max(200),
    at: z.number().finite(),
  }),
  z.strictObject({
    source: z.literal("code"),
    reference: z.string().min(1).max(300),
    at: z.null(),
  }),
])

const RadarEdge = z.strictObject({
  id: z.string().min(1).max(1024),
  kind: z.enum([
    "architecture",
    "ancestry",
    "association",
    "dependency",
    "assignment",
    "prompt",
    "outcome",
    "model-request",
    "model-response",
    "tool-call",
    "tool-result",
    "observation",
  ]),
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
  status: z.string().min(1).max(80),
  agentID: z.string().max(200).nullable(),
  deliveryStage: z
    .enum(["persisted", "admitted", "consumed", "unknown", "rejected", "superseded"])
    .nullable(),
  planID: z.uuid().nullable(),
  taskID: z.uuid().nullable(),
  attemptID: z.uuid().nullable(),
  messageID: z.string().max(200).nullable(),
  callID: z.string().max(200).nullable(),
  routeID: z.string().max(512).nullable(),
  startedAt: z.number().finite().nullable(),
  observedAt: z.number().finite().nullable(),
  live: z.boolean(),
  evidence: z.array(RadarEvidence).max(100),
})

export const RadarInput = z.strictObject({
  scope: ObservationScope,
  includeUnmanagedSessions: z.boolean().default(false),
})
export const RadarOutput = z.strictObject({
  schemaVersion: z.literal(1),
  projectID: z.string().min(1),
  scope: ObservationScopeView,
  observedAt: z.iso.datetime(),
  boundary: Boundary,
  freshness: z.strictObject({
    runner: z.literal("current"),
    nativeInventory: z.enum(["managed-only", "complete", "bounded", "unavailable"]),
    nativeEvents: z.enum(["connected", "gap-or-unavailable"]),
  }),
  coverage: z.strictObject({
    sessionCount: z.int().nonnegative(),
    managedSessionCount: z.int().nonnegative(),
    includeUnmanagedSessions: z.boolean(),
    inventoryTruncated: z.boolean(),
    workTruncated: z.boolean(),
    progressTruncated: z.boolean(),
    routeTruncated: z.boolean(),
    toolTruncated: z.boolean(),
    edgeTruncated: z.boolean(),
  }),
  components: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(120),
        responsibility: z.string().min(1).max(400),
        sourceFile: z.string().min(1).max(200),
      }),
    )
    .max(20),
  sessions: z.array(RadarSession).max(500),
  routes: z.array(RadarRoute).max(20_000),
  tools: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(512),
        name: z.string().min(1).max(160),
      }),
    )
    .max(200),
  plans: z
    .array(
      z.strictObject({
        id: z.uuid(),
        state: z.string().max(80),
        ownerSessionID: z.string().max(200),
        title: z.string().max(120).nullable(),
      }),
    )
    .max(1000),
  tasks: z
    .array(
      z.strictObject({
        id: z.uuid(),
        planID: z.uuid().nullable(),
        state: TaskState.or(z.literal("submitted")),
      }),
    )
    .max(1000),
  attempts: z
    .array(
      z.strictObject({
        id: z.uuid(),
        planID: z.uuid(),
        taskID: z.uuid(),
        sessionID: z.string().min(1).max(200),
        number: z.int().positive(),
        state: z.string().max(80),
        startedAt: z.number().finite(),
        configuredRouteID: z.string().max(512).nullable(),
      }),
    )
    .max(10_000),
  edges: z.array(RadarEdge).max(20_000),
})

export const TrajectoryInput = z
  .strictObject({
    scope: ObservationScope,
    taskID: z.uuid().optional(),
    attemptID: z.uuid().optional(),
    limit: z.int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .superRefine((input, ctx) => {
    if (Boolean(input.taskID) === Boolean(input.attemptID))
      ctx.addIssue({
        code: "custom",
        path: ["taskID"],
        message: "Provide exactly one taskID or attemptID in this observation scope",
      })
  })

export const TrajectoryOutput = z.strictObject({
  schemaVersion: z.literal(1),
  projectID: z.string().min(1),
  scope: ObservationScopeView,
  boundary: Boundary,
  report: z.record(z.string(), z.unknown()),
})

export const TrajectoryHistoryInput = z.strictObject({
  scope: ObservationScope,
  taskID: z.uuid(),
  limit: z.int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(4096).optional(),
})
export const TrajectoryHistoryOutput = z.strictObject({
  schemaVersion: z.literal(1),
  projectID: z.string().min(1),
  scope: ObservationScopeView,
  boundary: Boundary,
  capturedAt: z.number().finite(),
  expiresAt: z.number().finite(),
  eventIDs: z.array(z.string()).max(10_000).optional(),
  report: z.record(z.string(), z.unknown()),
})
export const TrajectoryHistoryErrorData = z.strictObject({
  reason: z.enum(["expired", "evicted", "invalid-cursor"]),
  recovery: z.literal("recapture"),
})
export const TrajectoryStatusInput = z.strictObject({ scope: ObservationScope, taskID: z.uuid() })

export const Changed = z.strictObject({
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
    radar: { input: RadarInput, output: RadarOutput },
    trajectory: { input: TrajectoryInput, output: TrajectoryOutput },
    trajectoryHistory: {
      input: TrajectoryHistoryInput,
      output: TrajectoryHistoryOutput,
      errors: { trajectory_history_unavailable: TrajectoryHistoryErrorData },
    },
    trajectoryStatus: { input: TrajectoryStatusInput, output: TrajectoryOutput },
  },
  events: { changed: { schema: Changed } },
})

export type ObservationScope = z.infer<typeof ObservationScope>
export type ObservationScopeView = z.infer<typeof ObservationScopeView>
export type SnapshotRequest = z.infer<typeof SnapshotInput>
export type SnapshotResponse = z.infer<typeof SnapshotOutput>
export type ProgressDiagnosticsRequest = z.infer<typeof ProgressDiagnosticsInput>
export type ProgressDiagnosticsResponse = z.infer<typeof ProgressDiagnosticsOutput>
export type RadarRequest = z.infer<typeof RadarInput>
export type RadarRequestInput = z.input<typeof RadarInput>
export type RadarResponse = z.infer<typeof RadarOutput>
export type TrajectoryRequest = z.infer<typeof TrajectoryInput>
export type TrajectoryResponse = z.infer<typeof TrajectoryOutput>
export type TrajectoryHistoryRequest = z.infer<typeof TrajectoryHistoryInput>
export type TrajectoryHistoryResponse = z.infer<typeof TrajectoryHistoryOutput>
export type TrajectoryHistoryErrorReason = z.infer<typeof TrajectoryHistoryErrorData>["reason"]
export type TrajectoryStatusRequest = z.infer<typeof TrajectoryStatusInput>
export type ObservationChange = z.infer<typeof Changed>
