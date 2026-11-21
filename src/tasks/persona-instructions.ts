import type { TaskPersona } from "../personas/schema.ts"

export function taskPersonaInstructions(persona: TaskPersona | undefined): string {
  return persona === undefined
    ? ""
    : `\n\n## Explicit task persona\n- ${persona}\n\nThis model-independent guidance is copied by manual Start only; an ordinary plan's explicitly authored node persona remains authoritative.`
}
