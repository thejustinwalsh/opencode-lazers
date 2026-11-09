import { z } from "zod"

export const WorkerAgent = z.enum(["lazers-implementor", "auditor"])
export type WorkerAgent = z.infer<typeof WorkerAgent>
export function isWorkerAgent(value: unknown): value is WorkerAgent {
  return value === "lazers-implementor" || value === "auditor"
}
export function workerAgent(value?: unknown): WorkerAgent {
  return value === "auditor" ? "auditor" : "lazers-implementor"
}
