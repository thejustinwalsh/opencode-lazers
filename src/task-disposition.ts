import { z } from "zod"

const text = z.string().trim().min(1).max(2_000)

const TaskDispositionKind = z.enum(["superseded", "rejected", "duplicate", "fulfilled"])
type TaskDispositionKind = z.infer<typeof TaskDispositionKind>

const TaskDispositionEvidence = z.strictObject({
  kind: z.enum(["verification", "artifact", "human"]),
  reference: text,
})
type TaskDispositionEvidence = z.infer<typeof TaskDispositionEvidence>

/** The durable, caller-supplied part of a disposition. */
export const TaskDispositionInput = z
  .strictObject({
    taskID: z.uuid(),
    requestID: z.string().trim().min(1).max(200),
    disposition: TaskDispositionKind,
    reason: text,
    evidence: z.array(TaskDispositionEvidence).min(1).max(20),
    relatedTaskIDs: z.array(z.uuid()).max(20).default([]),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.relatedTaskIDs).size !== input.relatedTaskIDs.length)
      ctx.addIssue({
        code: "custom",
        path: ["relatedTaskIDs"],
        message: "Duplicate related task ID",
      })
    if (input.relatedTaskIDs.includes(input.taskID))
      ctx.addIssue({
        code: "custom",
        path: ["relatedTaskIDs"],
        message: "A task cannot relate to itself",
      })
  })
export type TaskDispositionInput = z.infer<typeof TaskDispositionInput>

export const TaskDispositionRecord = z.strictObject({
  id: z.int().positive(),
  taskID: z.uuid(),
  requestID: z.string(),
  disposition: TaskDispositionKind,
  reason: z.string(),
  evidence: z.array(TaskDispositionEvidence),
  relatedTaskIDs: z.array(z.uuid()),
  sessionID: z.string(),
  agent: z.string(),
  createdAt: z.iso.datetime(),
})
export type TaskDispositionRecord = z.infer<typeof TaskDispositionRecord>

export function dispositionPayload(input: TaskDispositionInput) {
  return {
    taskID: input.taskID,
    disposition: input.disposition,
    reason: input.reason,
    evidence: input.evidence,
    relatedTaskIDs: input.relatedTaskIDs,
  }
}
