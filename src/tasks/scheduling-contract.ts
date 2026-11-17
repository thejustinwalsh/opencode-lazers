import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { TaskState } from "../runner/schema.ts"

export const SchedulingScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionID: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("project"), sessionID: z.string().min(1).max(200) }),
])

export const SchedulingInput = z.strictObject({
  scope: SchedulingScope,
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.int().min(1).max(100).default(50),
})

export const SchedulingDecision = z.enum(["eligible", "waiting", "unknown", "not-applicable"])
export const MAX_SCHEDULING_RESERVATION_REFERENCES = 100
export const MAX_SCHEDULING_PLAN_REFERENCES = 100

export const SchedulingNode = z.strictObject({
  taskID: z.uuid(),
  reference: z.string().max(19).optional(),
  title: z.string().max(120),
  objective: z.string().max(400),
  ordinal: z.int().nonnegative(),
  order: z.int().nonnegative(),
  lifecycle: TaskState,
  decision: SchedulingDecision,
  reason: z.string().max(400).nullable(),
  prerequisites: z.array(z.uuid()).max(100),
  waitingOn: z.array(z.uuid()).max(100),
  waitingOnPlans: z.array(z.uuid()).max(MAX_SCHEDULING_PLAN_REFERENCES).optional(),
  waitingOnPlansCount: z.int().nonnegative().optional(),
  waitingOnPlansComplete: z.boolean().optional(),
  reservationTaskIDs: z.array(z.uuid()).max(MAX_SCHEDULING_RESERVATION_REFERENCES),
  /** Distinct blocker task IDs known within this scope's captured scheduling facts. */
  reservationTaskCount: z.int().nonnegative().optional(),
  /** False when references are bounded or reservation capture is partial. */
  reservationTaskIDsComplete: z.boolean().optional(),
  /** True when Session scope omits known blocker IDs outside the visible task set. */
  reservationTaskIDsScopeLimited: z.boolean().optional(),
})

export const SchedulingPlan = z.strictObject({
  planID: z.uuid(),
  planVersion: z.int().positive(),
  planOrder: z.int().nonnegative(),
  priority: z.int(),
  title: z.string().max(120),
  lifecycle: z.string().min(1).max(80),
  decision: z.enum(["eligible", "waiting", "unknown"]),
  reason: z.string().max(400).nullable(),
  afterPlans: z.array(z.uuid()).max(1_000),
  nodes: z.array(SchedulingNode).max(100),
  nodesComplete: z.boolean(),
})

export const SchedulingCoverage = z.strictObject({
  status: z.enum(["complete", "partial"]),
  planCount: z.int().nonnegative(),
  coveredPlanCount: z.int().nonnegative(),
  nodeCount: z.int().nonnegative(),
  coveredNodeCount: z.int().nonnegative(),
  activeReservationCount: z.int().nonnegative(),
  reservationsComplete: z.boolean(),
  reason: z.string().max(400).nullable(),
})

const SchedulingCandidate = z.strictObject({
  planID: z.uuid(),
  taskID: z.uuid(),
  reference: z.string().max(19).optional(),
  title: z.string().max(120),
  priority: z.int(),
  planOrder: z.int().nonnegative(),
  ordinal: z.int().nonnegative(),
  order: z.int().nonnegative(),
})

export const SchedulingNext = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), candidate: SchedulingCandidate }),
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({ status: z.literal("unknown"), reason: z.string().max(400) }),
])

export const SchedulingSnapshot = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotID: z.uuid(),
  repositoryVersion: z.int().nonnegative(),
  scope: SchedulingScope,
  /** Unix milliseconds, including epoch zero. */
  observedAt: z.int().nonnegative(),
  coverage: SchedulingCoverage,
  next: SchedulingNext,
  selectedTaskIDs: z.array(z.uuid()).max(5_000),
  selectionComplete: z.boolean(),
  plans: z.array(SchedulingPlan).max(1_000),
})

export const SchedulingOutput = z.strictObject({
  ...SchedulingSnapshot.shape,
  plans: z.array(SchedulingPlan).max(100),
  nextCursor: z.string().max(2_048).nullable(),
})

export type SchedulingScope = z.infer<typeof SchedulingScope>
export type SchedulingInput = z.input<typeof SchedulingInput>
export type SchedulingDecision = z.infer<typeof SchedulingDecision>
export type SchedulingNode = z.infer<typeof SchedulingNode>
export type SchedulingPlan = z.infer<typeof SchedulingPlan>
export type SchedulingNext = z.infer<typeof SchedulingNext>
export type SchedulingSnapshot = z.infer<typeof SchedulingSnapshot>
export type SchedulingPage = z.infer<typeof SchedulingOutput>

export const TasksScheduling = Rpc.define({
  id: "lazers.tasks.scheduling",
  methods: {
    read: { input: SchedulingInput, output: SchedulingOutput },
  },
  events: {},
})
