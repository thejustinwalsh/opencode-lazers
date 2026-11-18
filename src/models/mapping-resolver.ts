import { workerPersonaLabels } from "../personas/index.ts"
import { agentLabels, isAgentSubject } from "./agent-ids.ts"

const subjectLabel = (subject: string) =>
  isAgentSubject(subject)
    ? agentLabels[subject]
    : workerPersonaLabels[subject as keyof typeof workerPersonaLabels]
import {
  ModelMappingResolutionInputSchema,
  ModelMappingResolutionSchema,
} from "./mapping-schema.ts"
import type { ModelMappingRecord, ModelMappingResolution } from "./mapping-schema.ts"
import { ModelMappingStore } from "./mapping-store.ts"

function hasRoute(mapping: ModelMappingRecord | null): mapping is ModelMappingRecord & {
  route: NonNullable<ModelMappingRecord["route"]>
} {
  return mapping !== null && mapping.route !== null
}

/** Resolves task > project > shared without catalog lookup or route substitution. */
export class ModelMappingResolver {
  constructor(readonly mappings: ModelMappingStore) {}

  resolve(input: unknown): ModelMappingResolution {
    const request = ModelMappingResolutionInputSchema.parse(input)
    const layers = this.mappings.layers(request.persona, request.taskID)
    const winner = [layers.task, layers.project, layers.shared].find(hasRoute)

    if (!winner)
      return ModelMappingResolutionSchema.parse({
        schemaVersion: 1,
        status: "unassigned",
        persona: request.persona,
        personaLabel: subjectLabel(request.persona),
        route: null,
        provenance: null,
      })

    return ModelMappingResolutionSchema.parse({
      schemaVersion: 1,
      status: "assigned",
      persona: request.persona,
      personaLabel: subjectLabel(request.persona),
      route: winner.route,
      provenance: { target: winner.target, revision: winner.revision },
    })
  }
}
