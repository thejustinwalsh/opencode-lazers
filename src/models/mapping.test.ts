import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workerPersonaLabels } from "../personas/index.ts"
import type { WorkerPersona } from "../runner/schema.ts"
import { TaskRepository } from "../storage.ts"
import { ModelMappingResolver } from "./mapping-resolver.ts"
import { ModelMappingStore } from "./mapping-store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lazers-model-mapping-"))
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
    variant: `native-variant/${name}`,
  }
}

const personas: WorkerPersona[] = ["ui", "systems", "small-refactoring"]

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("all personas resolve task > project > shared, with explicit absence and inheritance after removal", () => {
  const repository = open(databasePath(), "/project")
  const mappings = new ModelMappingStore(repository)
  const resolver = new ModelMappingResolver(mappings)
  const taskID = crypto.randomUUID()

  for (const [index, persona] of personas.entries()) {
    const sharedRoute = route(`shared-${index}`)
    const projectRoute = route(`project-${index}`)
    const taskRoute = route(`task-${index}`)

    expect(resolver.resolve({ persona, taskID })).toEqual({
      schemaVersion: 1,
      status: "unassigned",
      persona,
      personaLabel: workerPersonaLabels[persona],
      route: null,
      provenance: null,
    })

    expect(
      mappings.update({
        target: { scope: "shared" },
        persona,
        expectedRevision: 0,
        route: sharedRoute,
      }).status,
    ).toBe("updated")
    expect(resolver.resolve({ persona, taskID })).toMatchObject({
      status: "assigned",
      route: sharedRoute,
      provenance: { target: { scope: "shared" }, revision: 1 },
    })

    mappings.update({
      target: { scope: "project" },
      persona,
      expectedRevision: 0,
      route: projectRoute,
    })
    expect(resolver.resolve({ persona, taskID })).toMatchObject({
      status: "assigned",
      route: projectRoute,
      provenance: {
        target: { scope: "project", projectDirectory: "/project" },
        revision: 1,
      },
    })

    mappings.update({
      target: { scope: "task", taskID },
      persona,
      expectedRevision: 0,
      route: taskRoute,
    })
    expect(resolver.resolve({ persona, taskID })).toMatchObject({
      status: "assigned",
      route: taskRoute,
      provenance: {
        target: { scope: "task", projectDirectory: "/project", taskID },
        revision: 1,
      },
    })

    mappings.update({
      target: { scope: "task", taskID },
      persona,
      expectedRevision: 1,
      route: null,
    })
    expect(mappings.current({ scope: "task", taskID }, persona)?.route).toBeNull()
    expect(resolver.resolve({ persona, taskID })).toMatchObject({
      status: "assigned",
      route: projectRoute,
      provenance: {
        target: { scope: "project", projectDirectory: "/project" },
        revision: 1,
      },
    })

    mappings.update({
      target: { scope: "project" },
      persona,
      expectedRevision: 1,
      route: null,
    })
    expect(resolver.resolve({ persona, taskID })).toMatchObject({
      status: "assigned",
      route: sharedRoute,
      provenance: { target: { scope: "shared" }, revision: 1 },
    })

    mappings.update({
      target: { scope: "shared" },
      persona,
      expectedRevision: 1,
      route: null,
    })
    expect(resolver.resolve({ persona, taskID })).toMatchObject({
      status: "unassigned",
      route: null,
      provenance: null,
    })
  }
})

test("project and task assignments are isolated while shared routes inherit across projects", () => {
  const path = databasePath()
  const projectA = open(path, "/project-a")
  const projectB = open(path, "/project-b")
  const storeA = new ModelMappingStore(projectA)
  const storeB = new ModelMappingStore(projectB)
  const resolverA = new ModelMappingResolver(storeA)
  const resolverB = new ModelMappingResolver(storeB)
  const taskID = crypto.randomUUID()
  const sharedRoute = route("global-shared")
  const projectARoute = route("project-a")
  const projectBRoute = route("project-b")
  const taskARoute = route("task-a")
  const taskBRoute = route("task-b")

  storeA.update({
    target: { scope: "shared" },
    persona: "systems",
    expectedRevision: 0,
    route: sharedRoute,
  })
  storeA.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 0,
    route: projectARoute,
  })
  expect(resolverB.resolve({ persona: "systems", taskID })).toMatchObject({
    route: sharedRoute,
    provenance: { target: { scope: "shared" } },
  })

  storeB.update({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 0,
    route: projectBRoute,
  })
  expect(resolverA.resolve({ persona: "systems" })).toMatchObject({
    route: projectARoute,
    provenance: { target: { scope: "project", projectDirectory: "/project-a" } },
  })
  expect(resolverB.resolve({ persona: "systems" })).toMatchObject({
    route: projectBRoute,
    provenance: { target: { scope: "project", projectDirectory: "/project-b" } },
  })
  storeA.update({
    target: { scope: "task", taskID },
    persona: "systems",
    expectedRevision: 0,
    route: taskARoute,
  })
  storeB.update({
    target: { scope: "task", taskID },
    persona: "systems",
    expectedRevision: 0,
    route: taskBRoute,
  })

  expect(resolverA.resolve({ persona: "systems", taskID })).toMatchObject({
    route: taskARoute,
    provenance: { target: { scope: "task", projectDirectory: "/project-a", taskID } },
  })
  expect(resolverB.resolve({ persona: "systems", taskID })).toMatchObject({
    route: taskBRoute,
    provenance: { target: { scope: "task", projectDirectory: "/project-b", taskID } },
  })
  expect(resolverA.resolve({ persona: "systems", taskID: crypto.randomUUID() })).toMatchObject({
    route: projectARoute,
    provenance: { target: { scope: "project", projectDirectory: "/project-a" } },
  })
  expect(storeA.history({ scope: "project" }, "systems")).toHaveLength(1)
  expect(storeB.history({ scope: "project" }, "systems")).toHaveLength(1)
})

test("SQLite retains revisions across reopen, rejects stale competing updates, and keeps prior snapshots stable", () => {
  const path = databasePath()
  const firstRepository = open(path)
  const firstStore = new ModelMappingStore(firstRepository)
  const resolver = new ModelMappingResolver(firstStore)
  const firstRoute = route("durable-v1")
  const firstWrite = firstStore.update({
    target: { scope: "project" },
    persona: "ui",
    expectedRevision: 0,
    route: firstRoute,
  })
  if (firstWrite.status !== "updated") throw new Error("Initial mapping write failed")
  const earlierResolution = resolver.resolve({ persona: "ui" })

  firstRepository.close()
  const leftRepository = open(path)
  const rightRepository = open(path)
  const leftStore = new ModelMappingStore(leftRepository)
  const rightStore = new ModelMappingStore(rightRepository)
  expect(leftStore.current({ scope: "project" }, "ui")).toEqual(firstWrite.mapping)
  expect(leftStore.history({ scope: "project" }, "ui")).toEqual([firstWrite.mapping])

  const secondRoute = route("competing-left")
  const thirdRoute = route("competing-right")
  const contenders = [
    leftStore.update({
      target: { scope: "project" },
      persona: "ui",
      expectedRevision: 1,
      route: secondRoute,
    }),
    rightStore.update({
      target: { scope: "project" },
      persona: "ui",
      expectedRevision: 1,
      route: thirdRoute,
    }),
  ]
  const successful = contenders.find((result) => result.status === "updated")
  const conflict = contenders.find((result) => result.status === "conflict")
  expect(successful?.status).toBe("updated")
  expect(conflict).toMatchObject({ expectedRevision: 1, currentRevision: 2 })
  if (successful?.status !== "updated" || conflict?.status !== "conflict")
    throw new Error("Expected one update and one stale-revision conflict")
  expect(conflict.current).toEqual(successful.mapping)
  expect(earlierResolution).toMatchObject({
    status: "assigned",
    route: firstRoute,
    provenance: { target: { scope: "project", projectDirectory: "/project" }, revision: 1 },
  })

  const historySnapshot = leftStore.history({ scope: "project" }, "ui")
  const finalRoute = route("durable-v3")
  const finalWrite = leftStore.update({
    target: { scope: "project" },
    persona: "ui",
    expectedRevision: 2,
    route: finalRoute,
  })
  expect(finalWrite.status).toBe("updated")
  expect(historySnapshot).toHaveLength(2)
  expect(historySnapshot[0]).toEqual(firstWrite.mapping)
  expect(earlierResolution.route).toEqual(firstRoute)

  leftRepository.close()
  rightRepository.close()
  const reopenedRepository = open(path)
  const reopenedStore = new ModelMappingStore(reopenedRepository)
  expect(reopenedStore.current({ scope: "project" }, "ui")).toMatchObject({
    revision: 3,
    route: finalRoute,
  })
  expect(reopenedStore.history({ scope: "project" }, "ui")).toMatchObject([
    { revision: 1, route: firstRoute },
    { revision: 2, route: successful.mapping.route },
    { revision: 3, route: finalRoute },
  ])
})

test("mapping persistence changes neither tasks nor runner scheduling state", () => {
  const repository = open(databasePath())
  const mappings = new ModelMappingStore(repository)
  const resolver = new ModelMappingResolver(mappings)
  const baselineVersion = repository.version()
  const runnerTables = () =>
    repository.atomic((db) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_%' ORDER BY name",
        )
        .all(),
    )

  expect(runnerTables()).toEqual([])
  mappings.update({
    target: { scope: "shared" },
    persona: "small-refactoring",
    expectedRevision: 0,
    route: route("not-catalog-validated"),
  })
  expect(resolver.resolve({ persona: "small-refactoring" }).status).toBe("assigned")
  expect(repository.version()).toBe(baselineVersion)
  expect(repository.list()).toEqual([])
  expect(runnerTables()).toEqual([])
})
