import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, runCheck } from "../artifacts.ts"
import {
  createRetainedCheckContext,
  observeRetainedCheckContext,
  observeRetainedCheckIsolationWitness,
  removeRetainedCheckContextFromWitness,
  retainedCheckIsolationWitness,
} from "./isolation.ts"
import { bindRetainedCheckProcedure } from "./procedure.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test("real checks use an isolated worktree, SQLite database, and profile resource", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-isolation-repo-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-isolation-state-"))
  const oldProfile = join(state, "old-profile")
  const candidate = join(state, "candidate")
  const resourceRoot = join(state, "resources")
  const database = join(state, "tasks.sqlite")
  const receiptPath = join(state, "receipt.json")
  cleanups.push(() => {
    try {
      git(root, ["worktree", "remove", candidate])
    } catch {
      // A failing assertion must still clean this fixture, never production data.
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  writeFileSync(join(root, "tracked.txt"), "baseline\n")
  git(root, ["add", "tracked.txt"])
  git(root, ["commit", "-m", "baseline"])
  writeFileSync(join(root, "tracked.txt"), "candidate\n")
  git(root, ["add", "tracked.txt"])
  git(root, ["commit", "-m", "candidate"])
  const artifact = git(root, ["rev-parse", "HEAD"])
  git(root, ["worktree", "add", "--detach", candidate, artifact])
  const canonicalCandidate = realpathSync(candidate)
  writeFileSync(database, "")
  const old = new Database(database)
  old.close()
  writeFileSync(oldProfile, "old sentinel\n")
  const oldProfileContents = readFileSync(oldProfile, "utf8")
  const originalWorkspace = root
  const check = {
    id: "isolated-runtime",
    command:
      `mkdir -p "$HOME/profile" && printf 'verification only\\n' >> "$HOME/profile/sentinel" && ` +
      `bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.LAZERS_VERIFICATION_SQLITE); db.exec("CREATE TABLE IF NOT EXISTS writes(value TEXT); INSERT INTO writes VALUES (char(112,114,105,118,97,116,101))"); db.close()' && ` +
      `printf 'home=%s db=%s\\n' "$HOME" "$LAZERS_VERIFICATION_SQLITE"`,
    timeoutMs: 10_000,
  } as const
  const procedure = bindRetainedCheckProcedure(check.command)
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  const context = createRetainedCheckContext({
    rootDirectory: (await import("node:path")).dirname(resourceRoot),
    operationID: crypto.randomUUID(),
    generation: 1,
    phase: "task",
    checkID: "isolated-runtime",
    originalWorkspace,
    candidateWorkspace: candidate,
    taskDatabase: database,
    priorResourcePaths: [oldProfile],
    procedureBinding: procedure.binding,
  })
  expect(context.candidateWorkspace).toBe(canonicalCandidate)
  expect(context.directory).not.toBe(canonicalCandidate)
  expect(observeRetainedCheckContext(context)).toBe(true)

  const witness = retainedCheckIsolationWitness(context)
  const receipt = await runCheck(canonicalCandidate, artifact, check, receiptPath, {
    environment: context.environment,
    environmentIdentity: context.environmentIdentity,
    isolation: witness,
  })
  expect(receipt.exitCode, receipt.stderr).toBe(0)
  expect(receipt.unchanged).toBe(true)
  expect(receipt.cwd).toBe(canonicalCandidate)
  expect(receipt.stdout).toContain(`home=${context.environment.HOME}`)
  expect(receipt.stdout).toContain(`db=${context.environment.LAZERS_VERIFICATION_SQLITE}`)
  expect(readFileSync(oldProfile, "utf8")).toBe(oldProfileContents)
  const profile = join(context.environment.HOME!, "profile", "sentinel")
  expect(readFileSync(profile, "utf8")).toBe("verification only\n")
  const privateDB = new Database(context.environment.LAZERS_VERIFICATION_SQLITE!)
  try {
    expect(privateDB.query<{ value: string }, []>("SELECT value FROM writes").get()?.value).toBe(
      "private",
    )
  } finally {
    privateDB.close()
  }
  expect(existsSync(receiptPath)).toBe(true)
  expect(
    observeRetainedCheckIsolationWitness(context.directory, receipt.isolation, {
      operationID: context.operationID,
      generation: context.generation,
      phase: context.phase,
      checkID: context.checkID,
      originalWorkspace,
      candidateWorkspace: canonicalCandidate,
      taskDatabase: database,
      procedureBinding: procedure.binding,
    }),
  ).toBe(true)
  expect(
    new Set(context.resources.map((resource) => `${resource.device}:${resource.inode}`)).size,
  ).toBe(context.resources.length)
  removeRetainedCheckContextFromWitness(context.directory, receipt.isolation, {
    operationID: context.operationID,
    generation: context.generation,
    phase: context.phase,
    checkID: context.checkID,
    originalWorkspace,
    candidateWorkspace: canonicalCandidate,
    taskDatabase: database,
    procedureBinding: procedure.binding,
  })
  expect(existsSync(context.directory)).toBe(false)
})

test("a verification resource aliasing a retained workspace is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-isolation-alias-"))
  const repo = join(root, "repo")
  const candidate = join(root, "candidate")
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(repo)
  git(repo, ["init", "--initial-branch=main"])
  git(repo, ["config", "user.name", "fixture"])
  git(repo, ["config", "user.email", "fixture@example.invalid"])
  writeFileSync(join(repo, "tracked.txt"), "candidate\n")
  git(repo, ["add", "tracked.txt"])
  git(repo, ["commit", "-m", "candidate"])
  const artifact = git(repo, ["rev-parse", "HEAD"])
  git(repo, ["worktree", "add", "--detach", candidate, artifact])
  const taskDatabase = join(root, "tasks.sqlite")
  writeFileSync(taskDatabase, "")
  const db = new Database(taskDatabase)
  db.close()
  const readOnly = bindRetainedCheckProcedure("true")
  if (readOnly.status !== "supported") throw new Error(readOnly.reason)
  expect(() =>
    createRetainedCheckContext({
      rootDirectory: candidate,
      operationID: crypto.randomUUID(),
      generation: 1,
      phase: "task",
      checkID: "alias-check",
      originalWorkspace: repo,
      candidateWorkspace: candidate,
      taskDatabase,
      priorResourcePaths: [],
      procedureBinding: readOnly.binding,
    }),
  ).toThrow("Verification resource home aliases a retained or shared resource")
  expect(git(repo, ["rev-parse", "HEAD"])).toBe(artifact)
})

test("retained procedure binding accepts only the supported resource-bound subset", () => {
  const supported = bindRetainedCheckProcedure(
    `mkdir -p "$HOME/profile" && printf 'sentinel\\n' >> "$HOME/profile/state" && ` +
      `bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.LAZERS_VERIFICATION_SQLITE); db.exec("CREATE TABLE IF NOT EXISTS writes(value TEXT); INSERT INTO writes VALUES (char(120))"); db.close()'`,
  )
  expect(supported).toMatchObject({
    status: "supported",
    binding: { kind: "private-sqlite-smoke", resources: ["database", "home"] },
  })
  expect(bindRetainedCheckProcedure("bun ./scripts/check-profile.ts")).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("indirect script"),
  })
  expect(bindRetainedCheckProcedure("true; bun ./scripts/other-check.ts")).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("shell composition"),
  })
})
