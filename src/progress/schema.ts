import { z } from "zod"

/**
 * Progress is an annotation; identity and authority are never model inputs. Its length is not
 * limited: a handoff checkpoint that does not fit a cap is refused work, and panels that need a
 * short form derive it when they display the stored text.
 */
export const ProgressInput = z.strictObject({
  message: z.string().trim().min(1),
})

type ProgressInput = z.infer<typeof ProgressInput>

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
