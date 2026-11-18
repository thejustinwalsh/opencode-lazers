import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { architect, registerArchitect } from "../architect.ts"
import { AUDITOR_DEFAULT_MODEL, applyWorkerModel } from "../runner/roles.ts"
import { TaskRepository } from "../storage.ts"
import { agentRouteReader, applyAgentRoute, architectSessionModel } from "./agent-route-apply.ts"
import { isAgentSubject } from "./agent-ids.ts"
import { resolveDispatchRoute } from "./dispatch-resolution.ts"
import { ModelMappingResolver } from "./mapping-resolver.ts"
import { ModelSettingsService } from "./service.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
function open(projectDirectory = "/project") {
  const directory = mkdtempSync(join(tmpdir(), "lazers-agent-routing-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  return repository
}
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const route = (name: string, variant?: string) => ({
  providerID: "anthropic",
  id: `model-${name}`,
  ...(variant ? { variant } : {}),
})

// -- settings schema and layering -----------------------------------------------------------

test("settings carry the three agents beside the personas, with their own layers", () => {
  const service = new ModelSettingsService(open())
  const settings = service.settings()
  expect(settings.personas.map((entry) => entry.persona)).toEqual([
    "ui",
    "systems",
    "small-refactoring",
    "architect",
    "lazers-implementor",
    "auditor",
  ])
  const architectEntry = settings.personas.find((entry) => entry.persona === "architect")!
  expect(architectEntry).toMatchObject({
    personaLabel: "Architect",
    layers: { task: null, project: null, shared: null },
    resolution: { status: "unassigned" },
  })
})

test("an agent route layers project over shared, keeps history, and is never task-scoped", () => {
  const service = new ModelSettingsService(open())
  const read = agentRouteReader(service.repository)
  expect(read("architect")).toBeNull()

  const shared = service.configure({
    target: { scope: "shared" },
    persona: "architect",
    expectedRevision: 0,
    route: route("shared", "high"),
  })
  expect(shared).toMatchObject({ status: "updated", mapping: { revision: 1 } })
  expect(read("architect")).toMatchObject({ scope: "shared", route: route("shared", "high") })

  service.configure({
    target: { scope: "project" },
    persona: "architect",
    expectedRevision: 0,
    route: route("project"),
  })
  expect(read("architect")).toMatchObject({ scope: "project", route: route("project") })
  // Another agent is unaffected.
  expect(read("auditor")).toBeNull()

  // Removing the project route reveals the shared one; both revisions stay in history.
  service.configure({
    target: { scope: "project" },
    persona: "architect",
    expectedRevision: 1,
    route: null,
  })
  expect(read("architect")).toMatchObject({ scope: "shared" })
  expect(
    service.mappings.history({ scope: "project" }, "architect").map((r) => r.revision),
  ).toEqual([1, 2])

  // A stale revision is a conflict, not an overwrite.
  expect(
    service.configure({
      target: { scope: "shared" },
      persona: "architect",
      expectedRevision: 0,
      route: route("late"),
    }),
  ).toMatchObject({ status: "conflict", currentRevision: 1 })

  const taskID = crypto.randomUUID()
  expect(() =>
    service.configure({
      target: { scope: "task", taskID },
      persona: "architect",
      expectedRevision: 0,
      route: route("task"),
    }),
  ).toThrow(/not task-scoped/)
  expect(isAgentSubject("architect")).toBe(true)
  expect(isAgentSubject("ui")).toBe(false)
})

// -- the transforms: route, then native, then default -------------------------------------------

type Editable = { model?: unknown; name?: string }
function runArchitectTransform(initial: Editable, routes: Parameters<typeof registerArchitect>[1]) {
  let transform:
    ((editor: { update: (id: string, fn: (agent: Editable) => void) => void }) => void) | undefined
  registerArchitect(
    {
      agent: {
        transform: (fn: never) => {
          transform = fn
          return Effect.void
        },
      },
    } as never,
    routes,
  )
  const agent = { ...initial }
  transform!({ update: (_id, fn) => fn(agent) })
  return agent
}

test("the Architect transform sets the configured model and effort, else leaves native alone", () => {
  const set = runArchitectTransform({}, (id) =>
    id === "architect" ? { route: route("architect", "max"), scope: "project", revision: 1 } : null,
  )
  expect(set.model).toMatchObject({
    providerID: "anthropic",
    id: "model-architect",
    variant: "max",
  })
  expect(String(architect.id)).toBe("architect")
  const none = runArchitectTransform({}, () => null)
  expect(none.model).toBeUndefined()
  // Another agent's route is not the Architect's.
  const other = runArchitectTransform({}, (id) =>
    id === "auditor" ? { route: route("auditor"), scope: "shared", revision: 1 } : null,
  )
  expect(other.model).toBeUndefined()
})

test("Implementor and Auditor: LAZERS route, then native configuration, then the plugin default", () => {
  const native = { providerID: "openai", id: "native-model" }
  const routes = (id: string) =>
    id === "lazers-implementor" || id === "auditor"
      ? { route: route(id, "low"), scope: "shared" as const, revision: 3 }
      : null
  // A route wins over native configuration.
  for (const id of ["lazers-implementor", "auditor"]) {
    const agent: Editable = { model: native }
    applyWorkerModel(id, agent, routes)
    expect(agent.model).toMatchObject({ id: `model-${id}`, variant: "low" })
  }
  // No route: native configuration stands.
  for (const id of ["lazers-implementor", "auditor"]) {
    const agent: Editable = { model: native }
    applyWorkerModel(id, agent, () => null)
    expect(agent.model).toEqual(native)
  }
  // No route and no native model: only the Auditor has a default; the Implementor inherits.
  const auditor: Editable = {}
  applyWorkerModel("auditor", auditor, () => null)
  expect(auditor.model).toMatchObject(AUDITOR_DEFAULT_MODEL)
  const implementor: Editable = {}
  applyWorkerModel("lazers-implementor", implementor, () => null)
  expect(implementor.model).toBeUndefined()
  // Removing the route (a re-applied transform) puts the default back.
  const reapplied: Editable = {}
  applyWorkerModel("auditor", reapplied, routes)
  expect(reapplied.model).toMatchObject({ id: "model-auditor" })
  const after: Editable = {}
  applyWorkerModel("auditor", after, () => null)
  expect(after.model).toMatchObject(AUDITOR_DEFAULT_MODEL)
  applyAgentRoute(after, route("direct"))
  expect(after.model).toMatchObject({ id: "model-direct" })
})

test("a persona route still beats the Implementor agent route at dispatch", () => {
  const service = new ModelSettingsService(open())
  service.configure({
    target: { scope: "project" },
    persona: "lazers-implementor",
    expectedRevision: 0,
    route: route("implementor-agent"),
  })
  const effectiveImplementor = agentRouteReader(service.repository)("lazers-implementor")!.route
  const resolver = new ModelMappingResolver(service.mappings)
  const dispatch = (persona: "ui" | "systems") =>
    resolveDispatchRoute({
      schemaVersion: 1,
      persona,
      projectDirectory: "/project",
      explicitOverride: null,
      mappingResolution: {
        source: "model-mapping-resolver",
        resolution: resolver.resolve({ persona }),
      },
      // The native Implementor selection is the transformed agent: it carries the agent route.
      configuredImplementor: {
        source: "native-implementor-selection",
        route: effectiveImplementor,
      },
    })
  // No persona route: the Implementor agent route is what the attempt runs on.
  expect(dispatch("ui")).toMatchObject({ route: route("implementor-agent") })
  service.configure({
    target: { scope: "project" },
    persona: "ui",
    expectedRevision: 0,
    route: route("ui-persona"),
  })
  expect(dispatch("ui")).toMatchObject({ source: "project-mapping", route: route("ui-persona") })
  // The other persona still falls through to the Implementor agent route.
  expect(dispatch("systems")).toMatchObject({ route: route("implementor-agent") })
})

test("an Architect session LAZERS creates uses the configured route over the carried model", () => {
  const carried = route("carried")
  expect(architectSessionModel(null, carried)).toEqual(carried)
  expect(architectSessionModel(null, undefined)).toBeUndefined()
  expect(
    architectSessionModel({ route: route("configured"), scope: "project", revision: 1 }, carried),
  ).toEqual(route("configured"))
})
