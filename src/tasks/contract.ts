import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { TaskSpecSchema } from "../task.ts"
import { TaskState } from "../runner/schema.ts"

export const QueryInput = z.strictObject({
  search: z.string().max(200).default(""),
  scopePath: z.string().min(1).max(1_024).optional(),
  sessionID: z.string().min(1).max(200).optional(),
  limit: z.int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(2_048).optional(),
  includeCompleted: z.boolean().default(false),
})
export type TaskQuery = z.input<typeof QueryInput>
export const GetInput = z.strictObject({
  taskID: z.uuid(),
  revision: z.int().positive().optional(),
  sessionID: z.string().min(1).max(200).optional(),
})
export const GetInstructionsOutput = z.string()
export const TaskSummary = z.strictObject({
  taskID: z.uuid(),
  revision: z.literal(1),
  status: z.union([z.literal("submitted"), TaskState]),
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
  tasks: z.array(TaskSummary).max(100),
  nextCursor: z.string().nullable(),
  serverTime: z.iso.datetime(),
})
export type TaskPage = z.infer<typeof QueryOutput>
export const Execution = z.strictObject({
  planID: z.uuid(),
  taskID: z.uuid(),
  state: TaskState,
  version: z.int().positive(),
  reason: z.string().nullable(),
  waitingOn: z.array(z.uuid()),
})
export const GetOutput = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("found"),
    task: TaskSpecSchema,
    execution: Execution.optional(),
  }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("revision_unavailable"), revision: z.literal(1) }),
])
export type TaskDetail = z.infer<typeof GetOutput>
export const Changed = z.strictObject({
  projectDirectory: z.string(),
  version: z.int().nonnegative(),
})

export const Tasks = Rpc.define({
  id: "lazers.tasks",
  methods: {
    query: { input: QueryInput, output: QueryOutput },
    get: { input: GetInput, output: GetOutput },
  },
  events: { changed: { schema: Changed } },
})
