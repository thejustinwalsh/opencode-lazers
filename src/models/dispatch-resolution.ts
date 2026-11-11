import { z } from "zod"
import { ModelPolicy, WorkerPersona } from "../runner/schema.ts"
import { ModelMappingResolutionSchema } from "./mapping-schema.ts"
import type { ModelMappingResolution } from "./mapping-schema.ts"

const ExplicitOverrideInputSchema = z.strictObject({
  source: z.literal("explicit-plan-selection"),
  route: ModelPolicy,
})

const MappingResolutionInputSchema = z.strictObject({
  source: z.literal("model-mapping-resolver"),
  resolution: ModelMappingResolutionSchema,
})

const ConfiguredImplementorInputSchema = z.strictObject({
  source: z.literal("native-implementor-selection"),
  route: ModelPolicy.nullable(),
})

/** Inputs are snapshots from their named authorities; only the plan selection is intentional. */
export const DispatchRouteInputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    persona: WorkerPersona,
    projectDirectory: z.string().min(1),
    taskID: z.uuid().optional(),
    explicitOverride: ExplicitOverrideInputSchema.nullable(),
    mappingResolution: MappingResolutionInputSchema,
    configuredImplementor: ConfiguredImplementorInputSchema,
  })
  .superRefine((input, context) => {
    const resolution = input.mappingResolution.resolution
    if (resolution.persona !== input.persona) {
      context.addIssue({
        code: "custom",
        path: ["mappingResolution", "resolution", "persona"],
        message: "Mapping resolution persona does not match the dispatch persona",
      })
      return
    }

    if (resolution.status !== "assigned") return

    const { target } = resolution.provenance
    if (target.scope !== "shared" && target.projectDirectory !== input.projectDirectory) {
      context.addIssue({
        code: "custom",
        path: ["mappingResolution", "resolution", "provenance", "target"],
        message: "Mapping resolution belongs to a different project",
      })
    }
    if (target.scope === "task" && (input.taskID === undefined || target.taskID !== input.taskID)) {
      context.addIssue({
        code: "custom",
        path: ["mappingResolution", "resolution", "provenance", "target", "taskID"],
        message: "Task mapping resolution does not match the dispatch task",
      })
    }
  })

export type DispatchRouteInput = z.infer<typeof DispatchRouteInputSchema>

const SharedMappingDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("resolved"),
  persona: WorkerPersona,
  source: z.literal("shared-mapping"),
  route: ModelPolicy,
  provenance: z.strictObject({
    target: z.strictObject({ scope: z.literal("shared") }),
    revision: z.int().positive(),
  }),
})

const ProjectMappingDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("resolved"),
  persona: WorkerPersona,
  source: z.literal("project-mapping"),
  route: ModelPolicy,
  provenance: z.strictObject({
    target: z.strictObject({ scope: z.literal("project"), projectDirectory: z.string().min(1) }),
    revision: z.int().positive(),
  }),
})

const TaskMappingDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("resolved"),
  persona: WorkerPersona,
  source: z.literal("task-mapping"),
  route: ModelPolicy,
  provenance: z.strictObject({
    target: z.strictObject({
      scope: z.literal("task"),
      projectDirectory: z.string().min(1),
      taskID: z.uuid(),
    }),
    revision: z.int().positive(),
  }),
})

const ExplicitDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("resolved"),
  persona: WorkerPersona,
  source: z.literal("explicit-plan-selection"),
  route: ModelPolicy,
  provenance: z.null(),
})

const ConfiguredImplementorDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("resolved"),
  persona: WorkerPersona,
  source: z.literal("native-implementor-selection"),
  route: ModelPolicy,
  provenance: z.null(),
})

const UnavailableDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("unavailable"),
  persona: WorkerPersona,
  source: z.literal("unavailable"),
  route: z.null(),
  provenance: z.null(),
  reason: z.literal("no-route-available"),
})

/** Detached, versioned route snapshot; this decision does not activate dispatch. */
export const DispatchRouteDecisionSchema = z.discriminatedUnion("source", [
  ExplicitDecisionSchema,
  TaskMappingDecisionSchema,
  ProjectMappingDecisionSchema,
  SharedMappingDecisionSchema,
  ConfiguredImplementorDecisionSchema,
  UnavailableDecisionSchema,
])
export type DispatchRouteDecision = z.infer<typeof DispatchRouteDecisionSchema>

function decisionFromMapping(
  persona: DispatchRouteInput["persona"],
  resolution: Extract<ModelMappingResolution, { status: "assigned" }>,
): DispatchRouteDecision {
  const source =
    resolution.provenance.target.scope === "task"
      ? ("task-mapping" as const)
      : resolution.provenance.target.scope === "project"
        ? ("project-mapping" as const)
        : ("shared-mapping" as const)
  return DispatchRouteDecisionSchema.parse({
    schemaVersion: 1,
    status: "resolved",
    persona,
    source,
    route: resolution.route,
    provenance: resolution.provenance,
  })
}

/**
 * Resolve an exact dispatch route from already-read, source-tagged snapshots.
 * The mapping resolver remains responsible for choosing task/project/shared;
 * this function validates its provenance and applies only the outer precedence.
 */
export function resolveDispatchRoute(input: unknown): DispatchRouteDecision {
  const request = DispatchRouteInputSchema.parse(input)

  if (request.explicitOverride !== null)
    return DispatchRouteDecisionSchema.parse({
      schemaVersion: 1,
      status: "resolved",
      persona: request.persona,
      source: "explicit-plan-selection",
      route: request.explicitOverride.route,
      provenance: null,
    })

  const mapping = request.mappingResolution.resolution
  if (mapping.status === "assigned") return decisionFromMapping(request.persona, mapping)

  if (request.configuredImplementor.route !== null)
    return DispatchRouteDecisionSchema.parse({
      schemaVersion: 1,
      status: "resolved",
      persona: request.persona,
      source: "native-implementor-selection",
      route: request.configuredImplementor.route,
      provenance: null,
    })

  return DispatchRouteDecisionSchema.parse({
    schemaVersion: 1,
    status: "unavailable",
    persona: request.persona,
    source: "unavailable",
    route: null,
    provenance: null,
    reason: "no-route-available",
  })
}
