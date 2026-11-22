import { LAZERS_AGENTS, agentLabels, isAgentSubject } from "./agent-ids.ts"
import type { ModelMappingSubject } from "./agent-ids.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import type { ModelMappingRecord, ModelMappingResolution } from "./mapping-schema.ts"
import type { ModelPolicy } from "../runner/schema.ts"

/**
 * The Models assignments as the panel shows them, composed from stored layer rows
 * (`model_assignment_view`, `assignment-view.ts`). Pure and free of server imports, so the GUI and
 * the server build the same `ModelSettingsOutput` from the same rows.
 *
 * ```
 *  rows: shared ─┐
 *        project ├─► per subject: layers {task, project, shared} ─► resolution (task > project > shared)
 *        task ───┘                                               └► agents: host model + LAZERS route
 *        host (one per agent: the model OpenCode resolved for it)
 * ```
 */

/** The three worker personas, then the four agents: the order the panel lists them. */
const ASSIGNMENT_SUBJECTS = [
  "ui",
  "systems",
  "small-refactoring",
  ...LAZERS_AGENTS.map((agent) => agent.agentID),
] as const satisfies readonly ModelMappingSubject[]

const personaLabels = {
  ui: "UI",
  systems: "Systems",
  "small-refactoring": "Small task / refactoring",
}

const assignmentSubjectLabel = (subject: ModelMappingSubject) =>
  isAgentSubject(subject) ? agentLabels[subject] : personaLabels[subject]

/** One layer row: a mapping record (`shared`, `project`, `task`) or an agent's host fact (`host`). */
export type AssignmentLayerRow = {
  layer: string
  subject: string
  task_id: string
  record: unknown
}

/** What the host said about one agent when it was last read (`agent.get`). */
export type HostAgentFact = {
  /** False when the host did not answer for the agent: nothing is shown for it. */
  reachable: boolean
  /** The host's effective model; null when the agent pins none. */
  model: ModelPolicy | null
  /** The model is the plugin's own default for this agent (the Auditor's). */
  pluginDefault: boolean
}

export type AgentRouteView = NonNullable<ModelSettingsOutput["agents"]>[number]

/** The route an agent is configured to use: this project's, else the shared one (`agentRoute`). */
const lazersRoute = (layers: {
  project: ModelMappingRecord | null
  shared: ModelMappingRecord | null
}) => {
  for (const scope of ["project", "shared"] as const) {
    const record = layers[scope]
    if (record?.route) return { scope, route: record.route }
  }
  return null
}

/**
 * The model native OpenCode resolves for an agent: the host's effective model wins (it is what a
 * session will use); a LAZERS route the host has not applied yet is still the configured model.
 */
export function agentRouteOf(
  agentID: AgentRouteView["agentID"],
  host: HostAgentFact | undefined,
  set: { scope: "project" | "shared"; route: ModelPolicy } | null,
): AgentRouteView {
  const label = agentLabels[agentID]
  if (!host?.reachable) return { agentID, label, model: null, source: "none" }
  const model = host.model ?? set?.route ?? null
  if (set) return { agentID, label, model, source: set.scope }
  if (!model) return { agentID, label, model: null, source: "none" }
  return { agentID, label, model, source: host.pluginDefault ? "plugin-default" : "native" }
}

/** Task over project over shared; the first layer with a route wins (`ModelMappingResolver`). */
function resolveLayers(
  persona: ModelMappingSubject,
  layers: Record<"task" | "project" | "shared", ModelMappingRecord | null>,
): ModelMappingResolution {
  const personaLabel = assignmentSubjectLabel(persona)
  const winner = [layers.task, layers.project, layers.shared].find(
    (layer) => layer !== null && layer.route !== null,
  )
  if (!winner?.route)
    return {
      schemaVersion: 1,
      status: "unassigned",
      persona,
      personaLabel,
      route: null,
      provenance: null,
    }
  return {
    schemaVersion: 1,
    status: "assigned",
    persona,
    personaLabel,
    route: winner.route,
    provenance: { target: winner.target, revision: winner.revision },
  }
}

/** The settings of a project (or one task) from its layer rows, as the `settings` read returned them. */
export function assignmentSettingsOf(
  rows: readonly AssignmentLayerRow[],
  projectDirectory: string,
  taskID: string | null,
): ModelSettingsOutput {
  const record = (layer: string, subject: string) => {
    const row = rows.find(
      (entry) =>
        entry.layer === layer &&
        entry.subject === subject &&
        (layer !== "task" || entry.task_id === taskID),
    )
    return row ? (row.record as ModelMappingRecord) : null
  }
  const personas = ASSIGNMENT_SUBJECTS.map((persona) => {
    const layers = {
      task: taskID && !isAgentSubject(persona) ? record("task", persona) : null,
      project: record("project", persona),
      shared: record("shared", persona),
    }
    return {
      persona,
      personaLabel: assignmentSubjectLabel(persona),
      layers,
      resolution: resolveLayers(persona, layers),
    }
  })
  const agents = LAZERS_AGENTS.map(({ agentID }) => {
    const host = rows.find((entry) => entry.layer === "host" && entry.subject === agentID)
    const layers = personas.find((entry) => entry.persona === agentID)!.layers
    return agentRouteOf(agentID, host?.record as HostAgentFact | undefined, lazersRoute(layers))
  })
  return { projectDirectory, taskID, personas, agents }
}
