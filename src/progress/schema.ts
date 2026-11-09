import { z } from "zod"

/** Progress is one short annotation; identity and authority are never model inputs. */
export const ProgressInput = z.strictObject({
  message: z.string().trim().min(1).max(1200),
})

export type ProgressInput = z.infer<typeof ProgressInput>

export type NativeLineageRejection =
  | "observer-stopped"
  | "binding-changed"
  | "revision-changed"
  | "start-changed"
  | "event-changed"
  | "pending-terminal"
  | "terminal"
  | "input-changed"
  | "native-identity-changed"
  | "newer-start-fence"
  | "replay-not-current"
  | "replay-unavailable"
  | "assignment-missing"
  | "attempt-not-running"
  | "plan-not-running"
  | "task-disposed"
  | "invalid-start"
  | "invalid-event"
  | "input-not-assigned"
  | "assignment-changed"
