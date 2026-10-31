import smallRefactoring from "./small-refactoring.md" with { type: "text" }
import systems from "./systems.md" with { type: "text" }
import ui from "./ui.md" with { type: "text" }
import type { WorkerPersona } from "../runner/schema.ts"

const overlays: Record<WorkerPersona, string> = {
  ui,
  systems,
  "small-refactoring": smallRefactoring,
}

export const workerPersonaLabels: Record<WorkerPersona, string> = {
  ui: "UI",
  systems: "Systems",
  "small-refactoring": "Small task / refactoring",
}

export function workerPersonaOverlay(persona: WorkerPersona): string {
  return overlays[persona].trim()
}
