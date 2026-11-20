import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent, Location } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../runner/artifacts.ts"
import { TaskRepository } from "../storage.ts"
import { ProjectIndex } from "./index.ts"
import { RunnerStore } from "../runner/store.ts"
import { frozenPlanMap } from "./repo-map-store.ts"
import { nativeContextPermission, registerContextTools } from "./tools.ts"
import { registerTaskTools } from "../tools.ts"
import { validProposal } from "../../test/proposal.ts"
import { runRemoteAction } from "repomix"
import type { RepositorySnapshotWorker } from "./repository-snapshots.ts"
import { processRepositorySnapshot } from "./repo-processor.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const sessionID = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("session")
const messageID = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
  "message",
)
const callContext = (agent: string) =>
  ({
    sessionID,
    agent: Agent.ID.make(agent),
    messageID,
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
    progress: () => Effect.void,
  }) satisfies Parameters<RegisteredTool["execute"]>[1]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean()
})

async function setup(deniedAction?: string, repositoryWorker?: RepositorySnapshotWorker) {
  const root = mkdtempSync(join(tmpdir(), "lazers-context-tools-"))
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "README.md"), "project source")
  mkdirSync(join(root, "src"))
  writeFileSync(
    join(root, "src", "feature.ts"),
    "export function run() {}\nexport type Options = {}\n",
  )
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const deniedPaths = new Set<string>()
  const index = new ProjectIndex(
    root,
    join(root, "cache"),
    repository,
    async (path) => !deniedPaths.has(path),
    repositoryWorker,
  )
  const tools = new Map<string, RegisteredTool>()
  const assertions: string[] = []
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const context = {
    location: Schema.decodeUnknownSync(Location.Info)({
      directory: root,
      project: { id: "project", directory: root, canonical: root },
    }),
    permission: {
      assert: ({ action }: { action: string }) => {
        assertions.push(action)
        return action === deniedAction ? Effect.die(new Error("Permission denied")) : Effect.void
      },
    },
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerContextTools(context, index)))
  await Effect.runPromise(Effect.scoped(registerTaskTools(context, repository, index)))
  cleanup.push(() => {
    index.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, repository, index, tools, assertions, deniedPaths }
}

type Fixture = Awaited<ReturnType<typeof setup>>

async function submit(f: Fixture, key = "one-fetch", reference = "README.md:1") {
  const task = await Effect.runPromise(
    f.tools.get("lz-submit-task")!.execute(
      {
        ...validProposal(),
        idempotencyKey: key,
        context: [{ reference, revision: null }],
        guidance: "Start from README.md; preserve the existing contract.",
      },
      callContext("architect"),
    ),
  )
  return JSON.parse(String(task.content)).taskID as string
}

/** A real plan over the task, with one attempt per named worker session. */
function plan(f: Fixture, taskID: string, ...sessions: string[]) {
  const runner = new RunnerStore(f.repository)
  const { planID } = runner.submit(
    {
      requestID: `plan-${taskID}`,
      objective: "Map delivery.",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID, revision: 1 }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    },
    "architect",
  )
  runner.move(planID, taskID, "READY")
  runner.move(planID, taskID, "DISPATCH")
  f.repository.atomic((db) => {
    sessions.forEach((session, index) =>
      db
        .query(
          `INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          crypto.randomUUID(),
          planID,
          taskID,
          index + 1,
          session,
          `${session}-m`,
          "/",
          "a",
          "{}",
          "running",
          1,
        ),
    )
  })
  return planID
}

const fetchAs = (f: Awaited<ReturnType<typeof setup>>, taskID: string, session: string) =>
  Effect.runPromise(
    f.tools
      .get("lz-get-task")!
      .execute({ taskID }, { ...callContext("lazers-implementor"), sessionID: sessionOf(session) }),
  )
const sessionOf = (value: string) =>
  Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))(value)

test("one canonical worker fetch delivers task, the plan's map, then the named source read live", async () => {
  const f = await setup()
  const taskID = await submit(f)
  const planID = plan(f, taskID, "worker-1")
  f.assertions.length = 0
  writeFileSync(join(f.root, "README.md"), "live checkout text")
  const result = await fetchAs(f, taskID, "worker-1")
  const text = String(result.output)
  expect(text).toContain("## Done when")
  expect(text).toContain("## Verification")
  expect(text).toContain("## Implementation guidance")
  expect(text).not.toContain('"proposal"')
  expect(text).toContain("## Repository map")
  expect(text).toContain("as of plan start")
  expect(text).toContain("src/feature.ts: fn run; type Options")
  expect(text.indexOf("## Repository map")).toBeLessThan(text.indexOf("## Source context"))
  expect(text).toContain("live checkout text")
  expect(f.assertions).toEqual(["lz-get-task"])
  const row = f.repository.read((db) =>
    db
      .query<
        { plan_id: string; map_hash: string; map_tokens: number; source_context_tokens: number },
        []
      >("SELECT plan_id,map_hash,map_tokens,source_context_tokens FROM repo_map_deliveries")
      .get(),
  )!
  expect(row.plan_id).toBe(planID)
  expect(text).toContain(frozenPlanMap(f.repository, planID)!.text)
  expect(row.map_hash).toBe(frozenPlanMap(f.repository, planID)!.hash)
  expect(row.map_tokens).toBeGreaterThan(0)
  expect(row.source_context_tokens).toBeGreaterThan(0)
  f.deniedPaths.add("README.md")
  const denied = String((await fetchAs(f, taskID, "worker-1")).output)
  expect(denied).not.toContain("live checkout text")
  expect(denied).toContain("## Repository map")
})

test("every worker of a plan gets the same map bytes; a new plan gets a fresh one", async () => {
  const f = await setup()
  const taskID = await submit(f)
  const otherID = await submit(f, "second")
  plan(f, taskID, "worker-a", "worker-b")
  plan(f, otherID, "worker-c")
  const block = (text: string) =>
    text.slice(text.indexOf("## Repository map"), text.indexOf("## Source context"))
  const first = block(String((await fetchAs(f, taskID, "worker-a")).output))
  writeFileSync(join(f.root, "src", "added.ts"), "export const added = 1\n")
  const second = block(String((await fetchAs(f, taskID, "worker-b")).output))
  const next = block(String((await fetchAs(f, otherID, "worker-c")).output))
  expect(second).toBe(first)
  expect(first).not.toContain("src/added.ts")
  expect(next).toContain("src/added.ts: const added")
  const hashes = f.repository.read((db) =>
    db
      .query<{ session_id: string; map_hash: string }, []>(
        "SELECT session_id,map_hash FROM repo_map_deliveries ORDER BY session_id",
      )
      .all(),
  )
  expect(hashes[0]!.map_hash).toBe(hashes[1]!.map_hash)
  expect(hashes[2]!.map_hash).not.toBe(hashes[0]!.map_hash)
})

test("named code files arrive as outlines, cited line ranges as exact lines", async () => {
  const f = await setup()
  const outline = await submit(f, "outline", "src/feature.ts")
  plan(f, outline, "worker-o")
  const text = String((await fetchAs(f, outline, "worker-o")).output)
  expect(text).toContain("### src/feature.ts (outline)")
  expect(text).toContain("export function run")
  const ranged = await submit(f, "ranged", "src/feature.ts:2")
  plan(f, ranged, "worker-r")
  const rangedText = String((await fetchAs(f, ranged, "worker-r")).output)
  expect(rangedText).toContain("[Lines 2-2]\nexport type Options = {}")
  expect(rangedText).not.toContain("export function run() {}")
})

test("a session outside any plan gets no map and the retired tools are not registered", async () => {
  const f = await setup()
  const taskID = await submit(f)
  expect(String((await fetchAs(f, taskID, "stray")).output)).not.toContain("## Repository map")
  for (const name of ["lz-project-index", "lz-project-read", "lz-project-refresh"])
    expect(f.tools.has(name)).toBe(false)
})

test("registered repository tool preserves brace filters and long POSIX source paths on reread", async () => {
  const source = "## Compressed external source\nexport const feature = true;\n"
  const processedPath = `src/${"nested".repeat(180)}\\feature.ts`
  const include = [
    "src/**/*.{ts,tsx}",
    ...Array.from({ length: 19 }, (_, index) => `docs/group-${index}/**`),
    `docs/${"long-segment".repeat(50)}/**`,
  ]
  let seenInclude: string | undefined
  const remote: typeof runRemoteAction = async (_repository, options) => {
    seenInclude = options.include
    writeFileSync(options.output!, source)
    return {
      packResult: {
        processedFiles: [
          { path: processedPath, content: "export const feature = true;", level: "compress" },
        ],
        skippedFiles: [],
        totalCharacters: source.length,
        totalTokens: 20,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const worker: RepositorySnapshotWorker = (input) => processRepositorySnapshot(input, remote)
  const f = await setup(undefined, worker)
  const tool = f.tools.get("lz-repo-snapshot")!
  expect(
    tool.description.startsWith(
      "When researching external repositories or dependencies, get a compressed source snapshot in one call.",
    ),
  ).toBe(true)
  expect(tool.options).toMatchObject({
    codemode: true,
    pinned: true,
    permission: "lz-repo-snapshot",
  })

  const first = await Effect.runPromise(
    tool.execute({ repository: "owner/project", include, exclude: [] }, callContext("architect")),
  )
  expect(processedPath.length).toBeGreaterThan(1024)
  expect(seenInclude).toBe(include.join(","))
  expect(first.output.source).toContain("Compressed external source")
  expect(first.output.reused).toBe(false)
  expect(first.output.selection.include).toEqual(include)
  expect(first.output.selection.files).toEqual([processedPath])
  const reread = await Effect.runPromise(
    tool.execute({ snapshotID: first.output.snapshotID }, callContext("lazers-implementor")),
  )
  expect(reread.output).toMatchObject({
    snapshotID: first.output.snapshotID,
    source: first.output.source,
    reused: true,
  })
  expect(reread.output.selection.files).toEqual([processedPath])
  expect(f.assertions).toEqual(["lz-repo-snapshot", "lz-repo-snapshot"])
})

test("repository snapshot permission denial prevents any fetch or packing", async () => {
  let fetches = 0
  const f = await setup("lz-repo-snapshot", async () => {
    fetches++
  })
  const tool = f.tools.get("lz-repo-snapshot")!
  await expect(
    Effect.runPromise(
      tool.execute(
        { repository: "owner/project", include: [], exclude: [] },
        callContext("lazers-implementor"),
      ),
    ),
  ).rejects.toThrow("Permission denied")
  expect(fetches).toBe(0)
  expect(f.assertions).toEqual(["lz-repo-snapshot"])
})
