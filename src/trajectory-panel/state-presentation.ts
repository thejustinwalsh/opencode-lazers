import type { ExecutionListRow } from "../tasks/task-row.ts"
import { taskRowPresentation } from "../tasks/row-presentation.ts"
import type { TaskGlyph, TaskTone } from "../tasks/row-presentation.ts"

export type StatePresentation = { glyph: TaskGlyph; tone: TaskTone; label: string }

/**
 * Glyph, tone and word for a recorded task status, from the same mapping Tasks uses for its rows,
 * so one state has one glyph in every panel. Only the status is known here: runtime holds and
 * scheduling, which Tasks layers on top, are not part of a trajectory report.
 */
export function taskStatePresentation(status: string): StatePresentation {
  const presentation = taskRowPresentation({ status } as ExecutionListRow)
  return { glyph: presentation.icon, tone: presentation.tone, label: presentation.label }
}
