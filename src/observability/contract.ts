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
export type TrajectoryRequest = z.infer<typeof TrajectoryInput>
export type TrajectoryResponse = z.infer<typeof TrajectoryOutput>
export type TrajectoryHistoryRequest = z.infer<typeof TrajectoryHistoryInput>
export type TrajectoryHistoryResponse = z.infer<typeof TrajectoryHistoryOutput>
export type TrajectoryHistoryErrorReason = z.infer<typeof TrajectoryHistoryErrorData>["reason"]
export type TrajectoryStatusRequest = z.infer<typeof TrajectoryStatusInput>
export type ObservationChange = z.infer<typeof Changed>
