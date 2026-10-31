import { z } from "zod"

export const InspectTrajectoryInput = z
  .strictObject({
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
        message: "Provide exactly one project-owned taskID or attemptID",
      })
  })

export type InspectTrajectoryInput = z.infer<typeof InspectTrajectoryInput>
