import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../test/proposal.ts"
import { TaskRepository } from "./storage.ts"
import { submitTask } from "./submission.ts"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retry-"))
  directories.push(directory)
  const path = join(directory, "tasks.sqlite")
  const provenance = () => ({
    projectID: "p",
    projectDirectory: "/repo",
    workspaceDirectory: "/repo",
    sessionID: "s",
    startingRevision: { kind: "unborn" as const },
  })
  return { path, provenance }
}

test("lost receipts, closed connections, canonical keys and conflicts preserve identity", () => {
  const { path, provenance } = fixture()
  const repository = new TaskRepository(path, "/repo")
  const first = submitTask(repository, validProposal(), provenance, "logical-request")
  repository.close()
  const reordered = Object.fromEntries(Object.entries(validProposal()).reverse())
  expect(
    submitTask(
      repository,
      reordered,
      () => {
        throw new Error("retry must not collect new provenance")
      },
      "logical-request",
    ),
  ).toEqual(first)
  expect(
    submitTask(
      repository,
      { ...validProposal(), objective: "Different intent" },
      provenance,
      "logical-request",
    ).status,
  ).toBe("conflict")
  expect(repository.list()).toHaveLength(1)
  expect(submitTask(repository, validProposal(), provenance, "different-request")).not.toEqual(
    first,
  )
  expect(repository.list()).toHaveLength(2)
  const other = new TaskRepository(path, "/other")
  expect(
    submitTask(
      other,
      validProposal(),
      () => ({ ...provenance(), projectDirectory: "/other" }),
      "logical-request",
    ).status,
  ).toBe("submitted")
  other.close()
  repository.close()
})

test("real processes race one retry key and migration preserves genuine v1 data", async () => {
  const { path, provenance } = fixture()
  const legacy = new Database(path)
  legacy.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL); PRAGMA user_version=1",
  )
  const task = {
    schemaVersion: 1 as const,
    id: crypto.randomUUID(),
    revision: 1 as const,
    status: "submitted" as const,
    createdAt: new Date().toISOString(),
    provenance: provenance(),
    proposal: validProposal(),
  }
  legacy
    .query("INSERT INTO tasks VALUES(?,?,?,?)")
    .run(task.id, "/repo", task.createdAt, JSON.stringify(task))
  legacy.close()
  const script = `import {TaskRepository} from ${JSON.stringify(new URL("./storage.ts", import.meta.url).pathname)}; import {submitTask} from ${JSON.stringify(new URL("./submission.ts", import.meta.url).pathname)}; const r=new TaskRepository(process.argv[1],"/repo"); console.log(JSON.stringify(submitTask(r,JSON.parse(process.argv[2]),()=>JSON.parse(process.argv[3]),"race")));r.close()`
  const results = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          script,
          path,
          JSON.stringify(validProposal()),
          JSON.stringify(provenance()),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
      return JSON.parse(output)
    }),
  )
  expect(new Set(results.map((result) => result.taskID)).size).toBe(1)
  const repository = new TaskRepository(path, "/repo")
  expect(repository.get(task.id)).toEqual(task)
  expect(repository.list()).toHaveLength(2)
  repository.close()
})
