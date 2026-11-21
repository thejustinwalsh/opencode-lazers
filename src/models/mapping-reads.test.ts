import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { ModelMappingStore } from "./mapping-store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function store() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-mapping-reads-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  repositories.push(repository)
  const atomics = { count: 0 }
  const atomic = repository.atomic.bind(repository)
  repository.atomic = ((run: never) => {
    atomics.count++
    return atomic(run)
  }) as typeof repository.atomic
  return { mappings: new ModelMappingStore(repository), atomics }
}

test("listing agent routes takes no write transaction once the table exists", () => {
  const { mappings, atomics } = store()
  expect(mappings.agentRoute("architect")).toBeNull()
  const afterFirst = atomics.count
  for (let i = 0; i < 50; i++) mappings.agentRoute("architect")
  mappings.current({ scope: "shared" }, "ui")
  mappings.history({ scope: "shared" }, "ui")
  expect(atomics.count).toBe(afterFirst)
}, 120_000)

test("a read before any write still finds the table created, and sees later writes", () => {
  const { mappings } = store()
  expect(mappings.current({ scope: "shared" }, "ui")).toBeNull()
  const written = mappings.overwrite({
    target: { scope: "shared" },
    persona: "ui",
    route: { providerID: "p", id: "m" },
  })
  expect(written.status).toBe("updated")
  expect(mappings.current({ scope: "shared" }, "ui")?.revision).toBe(1)
}, 120_000)
