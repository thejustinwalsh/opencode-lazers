import { workerPersonaLabels } from "../personas/index.ts"
import { ModelMappingResolver } from "./mapping-resolver.ts"
import { ModelMappingStore } from "./mapping-store.ts"
import type { ModelMappingUpdate } from "./mapping-schema.ts"
import { ModelMappingUpdateSchema } from "./mapping-schema.ts"
import { ModelSettingsInputSchema, ModelSettingsOutputSchema } from "./contract.ts"
import type { ModelSettingsInput, ModelSettingsOutput } from "./contract.ts"
import type { TaskRepository } from "../storage.ts"

const personas = ["ui", "systems", "small-refactoring"] as const

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
        personas: personas.map((persona) => ({
          persona,
          personaLabel: workerPersonaLabels[persona],
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
    if (update.target.scope === "task") this.ensureTask(update.target.taskID)
    return this.mappings.update(update)
  }
}
