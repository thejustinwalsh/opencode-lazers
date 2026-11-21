import { z } from "zod"

/** Model-independent worker guidance shared by task and plan contracts. */
export const TaskPersonaSchema = z.enum(["ui", "systems", "small-refactoring"])
export type TaskPersona = z.infer<typeof TaskPersonaSchema>
