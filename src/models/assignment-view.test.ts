import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { modelAssignmentsSource } from "../streams/sources/models.ts"
import { MODEL_ASSIGNMENTS_WINDOW } from "../streams/sources/models-ref.ts"
import { readAgentRoutes, readHostAgentFacts } from "./agent-routes.ts"
import { assignmentSettingsOf, type AssignmentLayerRow } from "./assignment-settings.ts"
import { ensureModelAssignmentViewSchema, writeHostAgentFacts } from "./assignment-view.ts"
import { ModelSettingsService } from "./service.ts"
import { AUDITOR_DEFAULT_MODEL } from "../runner/roles.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function open(path: string, projectDirectory: string) {
  const repository = new TaskRepository(path, projectDirectory)
  repositories.push(repository)
  return repository
}

function insertTask(repository: TaskRepository) {
  const id = crypto.randomUUID()
  repository.insert({
    schemaVersion: 1,
    id,
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    proposal: validProposal(),
    provenance: {
      projectID: "project",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: repository.projectDirectory,
      sessionID: "owner-session",
      startingRevision: { kind: "unborn" },
    },
  })
  return id
}

const route = (id: string, variant?: string) => ({
  providerID: `provider-${id}`,
  id: `model-${id}`,
  ...(variant ? { variant } : {}),
})

/** The host as the fixture records it: one agent pins a model, the Auditor has the default. */
const hostModels: Record<string, { providerID: string; id: string; variant?: string } | "missing"> =
  {
    architect: route("architect-native"),
    auditor: { providerID: AUDITOR_DEFAULT_MODEL.providerID, id: AUDITOR_DEFAULT_MODEL.id },
    "lazers-planning-comprehension": "missing",
  }
const fakeHost = {
  agent: {
    get: ({ agentID }: { agentID: string }) =>
      hostModels[agentID] === "missing"
        ? Effect.fail(new Error("unknown agent"))
        : Effect.succeed({ data: { model: hostModels[agentID] } }),
  },
} as never

/**
 * The recorded fixture: the live database's shape on 2026-11-21 (11 records over 9 keys: shared 1,
 * project 5 over 4 keys, task 5 over 4 keys), with a removed route, a variant and an agent route,
 * in two projects so one project's layers never leak into the other.
 */
function recordFixture(service: ModelSettingsService, other: ModelSettingsService) {
  const first = insertTask(service.repository)
  const second = insertTask(service.repository)
  const third = insertTask(service.repository)
  const write = (s: ModelSettingsService, target: object, persona: string, value: unknown) =>
    s.configureCurrent({ target, persona, route: value })
  write(service, { scope: "shared" }, "systems", route("shared-systems"))
  write(service, { scope: "project" }, "ui", route("project-ui", "high"))
  write(service, { scope: "project" }, "ui", route("project-ui-2"))
  write(service, { scope: "project" }, "systems", null)
  write(service, { scope: "project" }, "architect", route("project-architect"))
  write(other, { scope: "project" }, "small-refactoring", route("other-project"))
  write(service, { scope: "task", taskID: first }, "ui", route("task-ui"))
  write(service, { scope: "task", taskID: first }, "ui", null)
  write(service, { scope: "task", taskID: first }, "systems", route("task-systems"))
  write(service, { scope: "task", taskID: second }, "small-refactoring", route("task-small"))
  write(service, { scope: "task", taskID: second }, "ui", route("task-ui-2", "low"))
  return { first, second, third }
}

/** The rows `models.assignments` reads, through the source's own filter and order. */
function streamRows(repository: TaskRepository, taskID: string | null): AssignmentLayerRow[] {
  const { where, params } = modelAssignmentsSource.filter({
    projectDirectory: repository.projectDirectory,
    sessionID: "session",
    taskID,
  })
  return repository.read((db) =>
    db
      .query<AssignmentLayerRow & { record: string }, string[]>(
        `SELECT * FROM model_assignment_view WHERE ${where} ORDER BY subject, layer, id`,
      )
      .all(...(params as string[]))
      .map((row) => ({ ...row, record: JSON.parse(row.record) })),
  )
}

test("assignments parity: the stored layer rows give the old settings read for every task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-assignment-view-"))
  directories.push(directory)
  const path = join(directory, "tasks.sqlite")
  const repository = open(path, "/project")
  const otherRepository = open(path, "/other")
  const service = new ModelSettingsService(repository)
  const other = new ModelSettingsService(otherRepository)
  // Records written before the install are backfilled; later ones arrive through the trigger.
  service.configureCurrent({ target: { scope: "shared" }, persona: "ui", route: route("early") })
  ensureModelAssignmentViewSchema(repository)
  const { first, second, third } = recordFixture(service, other)
  writeHostAgentFacts(repository, await readHostAgentFacts(fakeHost))

  for (const taskID of [null, first, second, third]) {
    const old = service.settings(taskID ? { taskID } : {})
    const set = new Map(
      ["architect", "lazers-implementor", "auditor", "lazers-planning"].flatMap((id) => {
        const found = service.mappings.agentRoute(id)
        return found ? [[id, found] as const] : []
      }),
    )
    const agents = await readAgentRoutes(fakeHost, undefined, (id) => set.get(id) ?? null)
    const rows = streamRows(repository, taskID)
    expect(rows.length).toBeLessThanOrEqual(MODEL_ASSIGNMENTS_WINDOW)
    expect(assignmentSettingsOf(rows, "/project", taskID)).toEqual({ ...old, agents })
  }
  // The other project's rows carry only its own project layer.
  const otherRows = streamRows(otherRepository, null)
  expect(otherRows.map((row) => [row.layer, row.subject])).toEqual([
    ["project", "small-refactoring"],
    ["shared", "systems"],
    ["shared", "ui"],
  ])
})

test("assignments: an unchanged host read writes nothing; a changed one writes its row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-assignment-host-"))
  directories.push(directory)
  const repository = open(join(directory, "tasks.sqlite"), "/project")
  ensureModelAssignmentViewSchema(repository)
  expect(writeHostAgentFacts(repository, await readHostAgentFacts(fakeHost))).toBe(4)
  expect(writeHostAgentFacts(repository, await readHostAgentFacts(fakeHost))).toBe(0)
  hostModels.architect = route("architect-changed")
  try {
    expect(writeHostAgentFacts(repository, await readHostAgentFacts(fakeHost))).toBe(1)
  } finally {
    hostModels.architect = route("architect-native")
  }
})

test("assignments: deleting a mapping record falls back to the key's newest remaining revision", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-assignment-delete-"))
  directories.push(directory)
  const repository = open(join(directory, "tasks.sqlite"), "/project")
  ensureModelAssignmentViewSchema(repository)
  const service = new ModelSettingsService(repository)
  service.configureCurrent({ target: { scope: "project" }, persona: "ui", route: route("one") })
  service.configureCurrent({ target: { scope: "project" }, persona: "ui", route: route("two") })
  repository.atomic((db) => db.exec("DELETE FROM model_mappings WHERE revision=2"))
  const [row] = streamRows(repository, null)
  expect(row).toMatchObject({ layer: "project", subject: "ui", revision: 1 })
  repository.atomic((db) => db.exec("DELETE FROM model_mappings"))
  expect(streamRows(repository, null)).toEqual([])
})
