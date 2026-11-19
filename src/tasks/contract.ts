import { FallowConfigRequired } from "../audit/fallow-refusal.ts"
import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { TaskReferenceSchema, TaskSpecSchema, TaskSourcePlanSchema } from "../task.ts"
import { TaskState, DispatchPause } from "../runner/schema.ts"
import { TaskDispositionRecord } from "../task-disposition.ts"
import { TaskClassificationRevision } from "../task-classification.ts"
import { TaskAdviceSnapshot } from "./advice.ts"
import { TaskStateFilter } from "./state-filter.ts"
import { AttemptModel, AttemptSummary } from "./attempt-summary.ts"

export const QueryInput = z.strictObject({
  sort: z.enum(["recent", "schedule"]).default("recent"),
  search: z.string().max(200).default(""),
  scopePath: z.string().min(1).max(1_024).optional(),
  sessionID: z.string().min(1).max(200).optional(),
  limit: z.int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(2_048).optional(),
  state: TaskStateFilter.optional(),
  includeCompleted: z.boolean().default(false),
  includeRetired: z.boolean().default(false),
})
export type TaskQuery = z.input<typeof QueryInput>
export const GetInput = z.strictObject({
  taskID: z.union([z.uuid(), TaskReferenceSchema]),
  revision: z.int().positive().optional(),
  classificationRevision: z.int().nonnegative().optional(),
  sessionID: z.string().min(1).max(200).optional(),
})
export const GetInstructionsOutput = z.string()
const TaskSummary = z.strictObject({
  taskID: z.uuid(),
  sourcePlan: TaskSourcePlanSchema.optional(),
  dispatchPause: DispatchPause.optional(),
  dispatchPausePlanID: z.uuid().optional(),
  // Read implementations resolve the persisted project-local reference before returning pages.
  reference: TaskReferenceSchema,
  revision: z.literal(1),
  status: z.union([z.literal("submitted"), TaskState]),
  /** Raw task-node lifecycle, distinct from a plan-level effective hold. */
  recordedState: TaskState.optional(),
  /** Epoch ms the current attempt started; present only while the task is running or verifying. */
  startedAt: z.number().finite().optional(),
  reason: z.string().nullable(),
  disposition: TaskDispositionRecord.optional(),
  classification: TaskClassificationRevision,
  title: z.string().max(120),
  objective: z.string().max(400),
  createdAt: z.iso.datetime(),
  sessionID: z.string(),
  matches: z.array(z.strictObject({ field: z.string(), snippet: z.string().max(240) })).max(4),
})
export type TaskSummary = z.infer<typeof TaskSummary>
export const QueryOutput = z.strictObject({
  projectDirectory: z.string(),
  snapshot: z.int().nonnegative(),
  count: z.int().nonnegative(),
  /** Tasks per state filter for this scope and search; first page only, absent on later pages. */
  stateCounts: z.partialRecord(TaskStateFilter, z.int().nonnegative()).optional(),
  tasks: z.array(TaskSummary).max(100),
  nextCursor: z.string().nullable(),
  serverTime: z.iso.datetime(),
})
export type TaskPage = z.infer<typeof QueryOutput>
const Execution = z.strictObject({
  dispatchPause: DispatchPause.optional(),
  planID: z.uuid(),
  taskID: z.uuid(),
  state: TaskState,
  version: z.int().positive(),
  reason: z.string().nullable(),
  waitingOn: z.array(z.uuid()),
})
const TaskActivity = z.strictObject({
  id: z.int().positive(),
  taskID: z.string().nullable(),
  event: z.string(),
  payload: z.string(),
  createdAt: z.number(),
})
const TaskAttempt = z.strictObject({
  id: z.uuid(),
  number: z.int().positive(),
  state: z.string(),
  startedAt: z.number(),
  artifact: z.string().nullable(),
  tokenCount: z.number().nullable(),
  toolCount: z.int().nonnegative(),
  /** The model the attempt was assigned, when its policy recorded one. */
  model: AttemptModel.optional(),
  /** Compact activity read; present on the task's latest attempt only. */
  summary: AttemptSummary.optional(),
})
export const CurrentActivityInput = z
  .strictObject({
    sessionID: z.string().min(1).max(200),
    scope: z.enum(["session", "project"]),
    taskIDs: z.array(z.uuid()).min(1).max(40),
  })
  .superRefine((input, context) => {
    if (new Set(input.taskIDs).size !== input.taskIDs.length)
      context.addIssue({ code: "custom", path: ["taskIDs"], message: "Task IDs must be unique" })
  })
const CurrentTaskActivity = z.strictObject({
  taskID: z.uuid(),
  /** Authorized exact worker association used to scope native activity notifications. */
  workerSessionID: z.string().min(1).optional(),
  attemptID: z.uuid().nullable(),
  foreground: z.enum(["active", "inactive", "unknown"]),
  archived: z.boolean().optional(),
  unknownReason: z.enum(["no-current-attempt", "unavailable"]).nullable(),
  recordedState: TaskState.nullable(),
  waiting: z.boolean(),
  holdReason: z.string().nullable(),
  pendingInput: z.boolean().nullable(),
  pendingPermissions: z.int().nonnegative().nullable(),
  pendingForms: z.int().nonnegative().nullable(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).nullable(),
  observedAt: z.number().finite().nullable(),
})
export const CurrentActivityOutput = z.strictObject({
  activities: z.array(CurrentTaskActivity).max(40),
})
type CurrentActivityInput = z.input<typeof CurrentActivityInput>
export type CurrentActivityOutput = z.infer<typeof CurrentActivityOutput>
export type CurrentTaskActivity = z.infer<typeof CurrentTaskActivity>
export const GetOutput = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("found"),
    task: TaskSpecSchema,
    classification: TaskClassificationRevision,
    classificationHistory: z.array(TaskClassificationRevision),
    classificationAtRevision: TaskClassificationRevision.nullable().optional(),
    advice: TaskAdviceSnapshot.nullable().default(null),
    auditHistory: z
      .strictObject({ runCount: z.int().positive(), latestRunID: z.uuid().nullable() })
      .optional(),
    reference: TaskReferenceSchema,
    disposition: TaskDispositionRecord.optional(),
    /** Raw node lifecycle, if planned, distinct from plan-level blocked presentation. */
    recordedState: TaskState.nullable().optional(),
    execution: Execution.optional(),
    architectSessionID: z.string().min(1).optional(),
    attempts: z.array(TaskAttempt).optional(),
    activity: z.array(TaskActivity).optional(),
  }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("revision_unavailable"), revision: z.literal(1) }),
])
export type TaskDetail = z.infer<typeof GetOutput>
const StartInput = z.strictObject({
  taskID: z.uuid(),
  revision: z.literal(1),
  sessionID: z.string().min(1).max(200),
})
const StartedOutput = z.strictObject({
  status: z.enum(["started", "existing"]),
  planID: z.uuid(),
  state: TaskState,
})
/** A start either runs, or is refused with the typed Fallow-config result (nothing queued). */
const StartOutput = z.union([StartedOutput, FallowConfigRequired])
export type StartTaskInput = z.infer<typeof StartInput>
export type StartTaskResult = z.infer<typeof StartedOutput>
export type StartTaskReply = z.infer<typeof StartOutput>
export const Changed = z.strictObject({
  projectDirectory: z.string(),
  version: z.int().nonnegative(),
})

export const Tasks = Rpc.define({
  id: "lazers.tasks",
  methods: {
    query: { input: QueryInput, output: QueryOutput },
    get: { input: GetInput, output: GetOutput },
    currentActivity: { input: CurrentActivityInput, output: CurrentActivityOutput },
    start: { input: StartInput, output: StartOutput },
  },
  events: { changed: { schema: Changed } },
})
