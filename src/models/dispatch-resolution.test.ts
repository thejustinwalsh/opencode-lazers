import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { ModelMappingResolver } from "./mapping-resolver.ts"
import { ModelMappingStore } from "./mapping-store.ts"
import type { DispatchRouteInput } from "./dispatch-resolution.ts"
import { resolveDispatchRoute } from "./dispatch-resolution.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lazers-dispatch-resolution-"))
  directories.push(directory)
  return join(directory, "tasks.sqlite")
}

function open(path: string, projectDirectory = "/project"): TaskRepository {
  const repository = new TaskRepository(path, projectDirectory)
  repositories.push(repository)
  return repository
}

function route(name: string) {
  return {
    providerID: `provider-not-in-catalog-${name}`,
    id: `model-not-in-catalog-${name}`,
    variant: `native-effort/${name}`,
  }
}

function input(
  resolution: ReturnType<ModelMappingResolver["resolve"]>,
  options: {
    persona?: "ui" | "systems" | "small-refactoring"
    projectDirectory?: string
    taskID?: string
    explicitOverride?: DispatchRouteInput["explicitOverride"]
    configuredImplementor?: DispatchRouteInput["configuredImplementor"]["route"]
  } = {},
): DispatchRouteInput {
  return {
    schemaVersion: 1,
    persona: options.persona ?? "systems",
    projectDirectory: options.projectDirectory ?? "/project",
    ...(options.taskID === undefined ? {} : { taskID: options.taskID }),
    explicitOverride: options.explicitOverride ?? null,
    mappingResolution: { source: "model-mapping-resolver", resolution },
    configuredImplementor: {
      source: "native-implementor-selection",
      route: options.configuredImplementor ?? null,
    },
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("dispatch decisions preserve explicit override, mapping precedence, and exact provenance", () => {
  const repository = open(databasePath())
  const mappings = new ModelMappingStore(repository)
  const resolver = new ModelMappingResolver(mappings)
  const taskID = crypto.randomUUID()
  const shared = route("shared")
  const project = route("project-final")
  const task = { ...route("task-final"), variant: "future/uncatalogued-native-effort+v9" }
  const configured = route("configured-implementor")
  const explicit = route("explicit-plan")

  mappings.update({
    target: { scope: "shared" },
    persona: "systems",
    expectedRevision: 0,
    route: shared,
  })
  mappings.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 0,
    route: route("project-temporary"),
  })
  mappings.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 1,
    route: null,
  })
  mappings.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 2,
    route: project,
  })
  mappings.update({
    target: { scope: "task", taskID },
    persona: "systems",
    expectedRevision: 0,
    route: route("task-temporary"),
  })
  mappings.update({
    target: { scope: "task", taskID },
    persona: "systems",
    expectedRevision: 1,
    route: task,
  })

  expect(
    resolveDispatchRoute(
      input(resolver.resolve({ persona: "systems", taskID }), {
        taskID,
        explicitOverride: { source: "explicit-plan-selection", route: explicit },
        configuredImplementor: configured,
      }),
    ),
  ).toEqual({
    schemaVersion: 1,
    status: "resolved",
    persona: "systems",
    source: "explicit-plan-selection",
    route: explicit,
    provenance: null,
  })

  expect(
    resolveDispatchRoute(
      input(resolver.resolve({ persona: "systems", taskID }), {
        taskID,
        configuredImplementor: configured,
      }),
    ),
  ).toEqual({
    schemaVersion: 1,
    status: "resolved",
    persona: "systems",
    source: "task-mapping",
    route: task,
    provenance: {
      target: { scope: "task", projectDirectory: "/project", taskID },
      revision: 2,
    },
  })

  mappings.update({
    target: { scope: "task", taskID },
    persona: "systems",
    expectedRevision: 2,
    route: null,
  })
  expect(
    resolveDispatchRoute(
      input(resolver.resolve({ persona: "systems", taskID }), {
        taskID,
        configuredImplementor: configured,
      }),
    ),
  ).toEqual({
    schemaVersion: 1,
    status: "resolved",
    persona: "systems",
    source: "project-mapping",
    route: project,
    provenance: { target: { scope: "project", projectDirectory: "/project" }, revision: 3 },
  })

  mappings.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 3,
    route: null,
  })
  expect(
    resolveDispatchRoute(
      input(resolver.resolve({ persona: "systems", taskID }), {
        taskID,
        configuredImplementor: configured,
      }),
    ),
  ).toEqual({
    schemaVersion: 1,
    status: "resolved",
    persona: "systems",
    source: "shared-mapping",
    route: shared,
    provenance: { target: { scope: "shared" }, revision: 1 },
  })

  mappings.update({
    target: { scope: "shared" },
    persona: "systems",
    expectedRevision: 1,
    route: null,
  })
  expect(
    resolveDispatchRoute(
      input(resolver.resolve({ persona: "systems", taskID }), {
        taskID,
        configuredImplementor: configured,
      }),
    ),
  ).toEqual({
    schemaVersion: 1,
    status: "resolved",
    persona: "systems",
    source: "native-implementor-selection",
    route: configured,
    provenance: null,
  })

  expect(
    resolveDispatchRoute(input(resolver.resolve({ persona: "systems", taskID }), { taskID })),
  ).toEqual({
    schemaVersion: 1,
    status: "unavailable",
    persona: "systems",
    source: "unavailable",
    route: null,
    provenance: null,
    reason: "no-route-available",
  })
})

test("configured implementor is fallback, never an intentional override", () => {
  const repository = open(databasePath())
  const resolver = new ModelMappingResolver(new ModelMappingStore(repository))
  const taskID = crypto.randomUUID()
  const configured = route("inherited-default")
  const request = input(resolver.resolve({ persona: "systems", taskID }), {
    taskID,
    configuredImplementor: configured,
  })

  expect(resolveDispatchRoute(request)).toEqual({
    schemaVersion: 1,
    status: "resolved",
    persona: "systems",
    source: "native-implementor-selection",
    route: configured,
    provenance: null,
  })
  expect(() =>
    resolveDispatchRoute({
      ...request,
      explicitOverride: { source: "native-implementor-selection", route: configured },
    }),
  ).toThrow()
  expect(() =>
    resolveDispatchRoute({
      ...request,
      explicitOverride: configured,
    }),
  ).toThrow()
})

test("legacy and foreign mapping snapshots cannot select a route or borrow provenance", () => {
  const path = databasePath()
  const localRepository = open(path, "/project")
  const foreignRepository = open(path, "/foreign-project")
  const localMappings = new ModelMappingStore(localRepository)
  const foreignMappings = new ModelMappingStore(foreignRepository)
  const localResolver = new ModelMappingResolver(localMappings)
  const foreignResolver = new ModelMappingResolver(foreignMappings)
  const taskID = crypto.randomUUID()
  const otherTaskID = crypto.randomUUID()
  const fallback = route("must-not-mask-invalid-snapshot")

  foreignMappings.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 0,
    route: route("foreign-project"),
  })
  localMappings.update({
    target: { scope: "task", taskID: otherTaskID },
    persona: "systems",
    expectedRevision: 0,
    route: route("foreign-task"),
  })
  localMappings.update({
    target: { scope: "project" },
    persona: "ui",
    expectedRevision: 0,
    route: route("foreign-persona"),
  })

  const foreignProject = foreignResolver.resolve({ persona: "systems", taskID })
  expect(() =>
    resolveDispatchRoute(
      input(foreignProject, {
        taskID,
        projectDirectory: "/project",
        configuredImplementor: fallback,
      }),
    ),
  ).toThrow()

  const foreignTask = localResolver.resolve({ persona: "systems", taskID: otherTaskID })
  expect(() =>
    resolveDispatchRoute(input(foreignTask, { taskID, configuredImplementor: fallback })),
  ).toThrow()

  const foreignPersona = localResolver.resolve({ persona: "ui", taskID })
  expect(() =>
    resolveDispatchRoute(
      input(foreignPersona, { taskID, persona: "systems", configuredImplementor: fallback }),
    ),
  ).toThrow()

  const legacyPersonaLess = {
    schemaVersion: 1,
    status: "assigned",
    personaLabel: "Systems",
    route: route("legacy"),
    provenance: {
      target: { scope: "task", projectDirectory: "/project", taskID },
      revision: 99,
    },
  }
  expect(() =>
    resolveDispatchRoute(
      input(legacyPersonaLess as never, { taskID, configuredImplementor: fallback }),
    ),
  ).toThrow()
})

test("decisions are deterministic, detached snapshots and do not mutate runtime state", () => {
  const repository = open(databasePath())
  const mappings = new ModelMappingStore(repository)
  const resolver = new ModelMappingResolver(mappings)
  const taskID = crypto.randomUUID()
  const unusualRoute = {
    ...route("opaque-route"),
    variant: "native/uncatalogued-effort+future-λ",
  }
  mappings.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 0,
    route: unusualRoute,
  })
  const request = input(resolver.resolve({ persona: "systems", taskID }), {
    taskID,
    configuredImplementor: route("unused-fallback"),
  })
  const versionBefore = repository.version()
  const tasksBefore = repository.list()
  const runnerTables = () =>
    repository.atomic((db) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_%' ORDER BY name",
        )
        .all(),
    )
  const runnerTablesBefore = runnerTables()

  const first = resolveDispatchRoute(request)
  const sameInput = resolveDispatchRoute(request)
  expect(first).toEqual(sameInput)
  expect(first).toEqual({
    schemaVersion: 1,
    status: "resolved",
    persona: "systems",
    source: "project-mapping",
    route: unusualRoute,
    provenance: { target: { scope: "project", projectDirectory: "/project" }, revision: 1 },
  })
  const earlier = structuredClone(first)

  const resolvedInput = request.mappingResolution.resolution
  if (resolvedInput.status !== "assigned") throw new Error("Expected an assigned mapping snapshot")
  resolvedInput.route.variant = "mutated-input"
  if (request.configuredImplementor.route)
    request.configuredImplementor.route.variant = "mutated-fallback"
  mappings.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 1,
    route: route("later-mapping-revision"),
  })

  expect(first).toEqual(earlier)
  expect(first.route).toEqual(unusualRoute)
  expect(repository.version()).toBe(versionBefore)
  expect(repository.list()).toEqual(tasksBefore)
  expect(runnerTables()).toEqual(runnerTablesBefore)
})
