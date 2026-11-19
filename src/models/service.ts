import { workerPersonaLabels } from "../personas/index.ts"
import { ModelMappingResolver } from "./mapping-resolver.ts"
import { ModelMappingStore } from "./mapping-store.ts"
import type { ModelMappingUpdate } from "./mapping-schema.ts"
import { ModelMappingToolInput, ModelMappingUpdateSchema } from "./mapping-schema.ts"
import { ModelSettingsInputSchema, ModelSettingsOutputSchema } from "./contract.ts"
import type { ModelSettingsInput, ModelSettingsOutput } from "./contract.ts"
import type { TaskRepository } from "../storage.ts"

import { LAZERS_AGENTS, agentLabels, isAgentSubject } from "./agent-ids.ts"

const personas = ["ui", "systems", "small-refactoring"] as const
const subjects = [...personas, ...LAZERS_AGENTS.map((agent) => agent.agentID)] as const

/** One project-scoped facade over the existing durable mapping store and resolver. */
export class ModelSettingsService {
  readonly mappings: ModelMappingStore
  readonly resolver: ModelMappingResolver

  constructor(readonly repository: TaskRepository) {
    this.mappings = new ModelMappingStore(repository)
    this.resolver = new ModelMappingResolver(this.mappings)
  }

  private ensureTask(taskID: string): void {
    if (this.repository.resolveTaskID(taskID) !== taskID)
      throw new Error("Task is unavailable in this project")
  }

  settings(input: unknown = {}): ModelSettingsOutput {
    const request: ModelSettingsInput = ModelSettingsInputSchema.parse(input)
    if (request.taskID !== undefined) this.ensureTask(request.taskID)

    return this.repository.atomic(() =>
      ModelSettingsOutputSchema.parse({
        projectDirectory: this.repository.projectDirectory,
        taskID: request.taskID ?? null,
        // Personas first, then the agents: all are routes in the one versioned store.
        personas: subjects.map((persona) => ({
          persona,
          personaLabel: isAgentSubject(persona)
            ? agentLabels[persona]
            : workerPersonaLabels[persona],
          layers: this.mappings.layers(persona, request.taskID),
          resolution: this.resolver.resolve({
            persona,
            ...(request.taskID ? { taskID: request.taskID } : {}),
          }),
        })),
      }),
    )
  }

  configure(input: unknown) {
    const update: ModelMappingUpdate = ModelMappingUpdateSchema.parse(input)
    this.assertTarget(update)
    return this.mappings.update(update)
  }

  /** Model tool: no revision supplied; writes against the current mapping. */
  configureCurrent(input: unknown) {
    const update = ModelMappingToolInput.parse(input)
    this.assertTarget(update)
    return this.mappings.overwrite(update)
  }

  private assertTarget(update: Pick<ModelMappingUpdate, "target" | "persona">) {
    if (update.target.scope === "task") {
      // An agent is the same agent in every task; only personas can be overridden per task.
      if (isAgentSubject(update.persona)) throw new Error("An agent route is not task-scoped")
      this.ensureTask(update.target.taskID)
    }
  }
}
