import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { ModelMappingStore } from "./mapping-store.ts"
import { ModelSettingsService } from "./service.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-model-service-"))
  directories.push(directory)
  return join(directory, "tasks.sqlite")
}

function open(path: string, projectDirectory = "/project") {
  const repository = new TaskRepository(path, projectDirectory)
  repositories.push(repository)
  return repository
}

function insertTask(repository: TaskRepository, id = crypto.randomUUID()) {
  const task = {
    schemaVersion: 1 as const,
    id,
    revision: 1 as const,
    status: "submitted" as const,
    createdAt: new Date().toISOString(),
    proposal: validProposal(),
    provenance: {
      projectID: "project",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: repository.projectDirectory,
      sessionID: "owner-session",
      startingRevision: { kind: "unborn" as const },
    },
  }
  repository.insert(task)
  return id
}

function route(id: string) {
  return {
    providerID: `catalog-independent-provider-${id}`,
    id: `catalog-independent-model-${id}`,
    variant: `native-effort/${id}`,
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("settings expose exact durable layers, revisions, route variants and inheritance", () => {
  const path = databasePath()
  const repository = open(path)
  const service = new ModelSettingsService(repository)
  const taskID = insertTask(repository)
  const shared = route("shared")
  const project = route("project")
  const task = route("task")

  expect(service.settings({ taskID }).personas[1]).toMatchObject({
    persona: "systems",
    layers: { task: null, project: null, shared: null },
    resolution: { status: "unassigned", provenance: null, route: null },
  })

  expect(
    service.configure({
      target: { scope: "shared" },
      persona: "systems",
      expectedRevision: 0,
      route: shared,
    }),
  ).toMatchObject({ status: "updated", mapping: { revision: 1, route: shared } })
  service.configure({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 0,
    route: project,
  })
  service.configure({
    target: { scope: "task", taskID },
    persona: "systems",
    expectedRevision: 0,
    route: task,
  })

  const configured = service.settings({ taskID }).personas[1]!
  expect(configured.layers).toMatchObject({
    task: {
      target: { scope: "task", projectDirectory: "/project", taskID },
      persona: "systems",
      revision: 1,
      route: task,
    },
    project: {
      target: { scope: "project", projectDirectory: "/project" },
      persona: "systems",
      revision: 1,
      route: project,
    },
    shared: { target: { scope: "shared" }, persona: "systems", revision: 1, route: shared },
  })
  expect(configured.resolution).toMatchObject({
    status: "assigned",
    route: task,
    provenance: { target: { scope: "task", projectDirectory: "/project", taskID }, revision: 1 },
  })

  expect(
    service.configure({
      target: { scope: "task", taskID },
      persona: "systems",
      expectedRevision: 1,
      route: null,
    }),
  ).toMatchObject({ status: "updated", mapping: { revision: 2, route: null } })
  const replay = service.configure({
    target: { scope: "task", taskID },
    persona: "systems",
    expectedRevision: 1,
    route: null,
  })
  expect(replay).toMatchObject({
    status: "conflict",
    expectedRevision: 1,
    currentRevision: 2,
    current: { revision: 2, route: null },
  })
  expect(new ModelMappingStore(repository).history({ scope: "task", taskID }, "systems")).toEqual([
    expect.objectContaining({ revision: 1, route: task }),
    expect.objectContaining({ revision: 2, route: null }),
  ])
  expect(service.settings({ taskID }).personas[1]?.resolution).toMatchObject({
    status: "assigned",
    route: project,
    provenance: { target: { scope: "project", projectDirectory: "/project" }, revision: 1 },
  })

  service.configure({
    target: { scope: "project" },
    persona: "systems",
    expectedRevision: 1,
    route: null,
  })
  expect(service.settings({ taskID }).personas[1]?.resolution).toMatchObject({
    status: "assigned",
    route: shared,
    provenance: { target: { scope: "shared" }, revision: 1 },
  })

  repository.close()
  const reopened = open(path)
  const reopenedService = new ModelSettingsService(reopened)
  expect(reopenedService.settings({ taskID }).personas[1]).toMatchObject({
    layers: {
      task: { revision: 2, route: null },
      project: { revision: 2, route: null },
      shared: { revision: 1, route: shared },
    },
    resolution: { status: "assigned", route: shared },
  })
  const history = new ModelMappingStore(reopened).history({ scope: "task", taskID }, "systems")
  expect(history).toHaveLength(2)
  expect(history.map(({ revision, route: saved }) => ({ revision, route: saved }))).toEqual([
    { revision: 1, route: task },
    { revision: 2, route: null },
  ])

  const independent = new Database(path, { readonly: true, strict: true })
  try {
    const rows = independent
      .query<{ scope: string; revision: number; payload: string }, []>(
        "SELECT scope, revision, payload FROM model_mappings ORDER BY scope, revision",
      )
      .all()
    expect(rows.filter((row) => row.scope === "task")).toHaveLength(2)
    expect(rows.filter((row) => row.scope === "project")).toHaveLength(2)
    expect(rows.filter((row) => row.scope === "shared")).toHaveLength(1)
    expect(rows.map((row) => JSON.parse(row.payload))).toContainEqual(
      expect.objectContaining({ persona: "systems", revision: 2, route: null }),
    )
  } finally {
    independent.close()
  }
})

test("foreign and missing task targets fail without creating model mappings", () => {
  const path = databasePath()
  const local = open(path, "/project")
  const foreign = open(path, "/other-project")
  const foreignTaskID = insertTask(foreign)
  const service = new ModelSettingsService(local)

  for (const taskID of [foreignTaskID, crypto.randomUUID()]) {
    expect(() =>
      service.configure({
        target: { scope: "task", taskID },
        persona: "ui",
        expectedRevision: 0,
        route: route("rejected"),
      }),
    ).toThrow("Task is unavailable in this project")
    expect(() => service.settings({ taskID })).toThrow("Task is unavailable in this project")
  }

  const db = new Database(path, { readonly: true, strict: true })
  try {
    const table = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='model_mappings'",
      )
      .get()
    expect(table).toBeNull()
  } finally {
    db.close()
  }
})
