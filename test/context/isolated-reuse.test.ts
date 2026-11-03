import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent, Location } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../../src/runner/artifacts.ts"
import { TaskRepository } from "../../src/storage.ts"
import { ProjectIndex } from "../../src/context/index.ts"
import type { ContextHost, ContextSession } from "../../src/context/index.ts"
import { WorkspaceIndexUnavailable } from "../../src/context/index.ts"
import { registerContextTools } from "../../src/context/tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup() {
  const temp = mkdtempSync(join(tmpdir(), "lazers-isolated-context-"))
  const sourcePath = join(temp, "source")
  const workerPath = join(temp, "worker")
  const cache = join(temp, "context-cache")
  const database = join(temp, "tasks.sqlite")
  mkdirSync(sourcePath)
  const source = realpathSync(sourcePath)
  git(source, ["init", "--initial-branch=main"])
  writeFileSync(join(source, "README.md"), "published source from Architect\n")
  writeFileSync(join(source, "src.ts"), "export const source = 'Architect'\n")
  git(source, ["add", "."])
  git(source, [
    "-c",
    "user.name=LAZERS test",
    "-c",
    "user.email=lazers-test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ])
  git(source, ["worktree", "add", "-b", "worker", workerPath])
  const worker = realpathSync(workerPath)
  writeFileSync(join(worker, "README.md"), "different live worker source\n")

  const sessions = new Map<string, ContextSession>([
    [
      "ses_architect",
      { id: "ses_architect", projectID: "project", directory: source, agent: "architect" },
    ],
    [
      "ses_worker",
      {
        id: "ses_worker",
        parentID: "ses_architect",
        projectID: "project",
        directory: worker,
        agent: "lazers-implementor",
      },
    ],
    [
      "ses_other_architect",
      { id: "ses_other_architect", projectID: "project", directory: source, agent: "architect" },
    ],
  ])
  const sessionReads: string[] = []
  const host: ContextHost = {
    projectID: "project",
    session: async (id) => {
      sessionReads.push(id)
      return sessions.get(id) ?? null
    },
  }
  const denied = new Set<string>()
  const permissionReads: { path: string; workspace: string; agent: string }[] = []
  const allow = async (path: string, principal: { agent: string }, workspace: string) => {
    permissionReads.push({ path, workspace, agent: principal.agent })
    return !denied.has(`${workspace}/${path}`)
  }
  const canonical = source
  let sourceRepository = new TaskRepository(database, canonical)
  let workerRepository = new TaskRepository(database, canonical)
  let sourceIndex = new ProjectIndex(source, cache, sourceRepository, allow, host)
  let workerIndex = new ProjectIndex(worker, cache, workerRepository, allow, host)
  const repositories: TaskRepository[] = [sourceRepository, workerRepository]
  const indexes: ProjectIndex[] = [sourceIndex, workerIndex]
  cleanups.push(() => {
    for (const index of indexes) index.close()
    for (const repository of repositories) repository.close()
    rmSync(temp, { recursive: true, force: true })
  })

  const reopenWorker = () => {
    workerIndex.close()
    workerRepository.close()
    workerRepository = new TaskRepository(database, canonical)
    workerIndex = new ProjectIndex(worker, cache, workerRepository, allow, host)
    repositories.push(workerRepository)
    indexes.push(workerIndex)
    return workerIndex
  }
  const reopenSource = () => {
    sourceIndex.close()
    sourceRepository.close()
    sourceRepository = new TaskRepository(database, canonical)
    sourceIndex = new ProjectIndex(source, cache, sourceRepository, allow, host)
    repositories.push(sourceRepository)
    indexes.push(sourceIndex)
    return sourceIndex
  }
  const state = () => ({
    files: readdirSync(cache)
      .sort()
      .map((name) => {
        const stat = statSync(join(cache, name))
        return [name, stat.size, stat.mtimeMs]
      }),
    pointers: sourceRepository.atomic((db) => ({
      cache: db.query("SELECT * FROM context_cache ORDER BY workspace,selection").all(),
      publications: db
        .query("SELECT * FROM context_publications ORDER BY project_id,owner_session")
        .all(),
    })),
  })
  return {
    temp,
    source,
    worker,
    cache,
    database,
    sessions,
    sessionReads,
    denied,
    permissionReads,
    get sourceIndex() {
      return sourceIndex
    },
    get workerIndex() {
      return workerIndex
    },
    reopenWorker,
    reopenSource,
    state,
  }
}

const callContext = (session: string, agent: string) => ({
  sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))(session),
  agent: Agent.ID.make(agent),
  messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
    "message",
  ),
  id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
  progress: () => Effect.void,
})

async function register(index: ProjectIndex, root: string, denyAction?: string) {
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
        return action === denyAction ? Effect.die(new Error("Permission denied")) : Effect.void
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
  return { tools, assertions }
}

function forbidIndexing(index: ProjectIndex) {
  const fail = () => {
    throw new Error("Read must not collect or process a workspace")
  }
  Reflect.set(index, "collectWorkspace", fail)
  Reflect.set(index, "processWorkspace", fail)
}

test("an owned implementor reuses its Architect publication across reopened real Git worktrees", async () => {
  const f = setup()
  const published = await f.sourceIndex.refresh({ sessionID: "ses_architect", agent: "architect" })
  const before = f.state()
  forbidIndexing(f.workerIndex)

  let workerTools = await register(f.workerIndex, f.worker)
  const manifest = await Effect.runPromise(
    workerTools.tools
      .get("lz-project-index")!
      .execute({ paths: ["README.md"] }, callContext("ses_worker", "lazers-implementor")),
  )
  const read = await Effect.runPromise(
    workerTools.tools
      .get("lz-project-read")!
      .execute(
        { paths: ["README.md"], level: "full" },
        callContext("ses_worker", "lazers-implementor"),
      ),
  )
  expect(manifest.output).toMatchObject({
    snapshotID: published.id,
    refreshedAt: published.createdAt,
    freshness: "as-of-refresh",
    workspace: f.source,
  })
  expect(read.output).toMatchObject({
    snapshotID: published.id,
    refreshedAt: published.createdAt,
    freshness: "as-of-refresh",
    workspace: f.source,
  })
  expect(read.output.sources).toEqual([
    expect.objectContaining({ path: "README.md", text: "published source from Architect\n" }),
  ])
  expect(read.output.sources[0]!.text).not.toBe(readFileSync(join(f.worker, "README.md"), "utf8"))
  expect(f.permissionReads).toContainEqual({
    path: "README.md",
    workspace: f.source,
    agent: "lazers-implementor",
  })
  expect(f.state()).toEqual(before)

  const reopenedSource = f.reopenSource()
  const sourceAfterReopen = await reopenedSource.manifest({
    sessionID: "ses_architect",
    agent: "architect",
  })
  const reopened = f.reopenWorker()
  forbidIndexing(reopened)
  workerTools = await register(reopened, f.worker)
  const afterReopen = await Effect.runPromise(
    workerTools.tools
      .get("lz-project-read")!
      .execute(
        { paths: ["README.md"], level: "full" },
        callContext("ses_worker", "lazers-implementor"),
      ),
  )
  expect(afterReopen.output).toMatchObject({
    snapshotID: published.id,
    refreshedAt: published.createdAt,
    workspace: f.source,
  })
  expect(sourceAfterReopen).toMatchObject({
    snapshotID: published.id,
    refreshedAt: published.createdAt,
    workspace: f.source,
  })
  expect(afterReopen.output.sources[0]!.text).toContain("published source from Architect")
  expect(f.state()).toEqual(before)
})

test("tool denial precedes native lookup, and denied or revoked source permissions reveal no files or bytes", async () => {
  const f = setup()
  await f.sourceIndex.refresh({ sessionID: "ses_architect", agent: "architect" })
  const before = f.sessionReads.length
  const beforePermissions = f.permissionReads.length
  const deniedTools = await register(f.workerIndex, f.worker, "lz-project-read")
  await expect(
    Effect.runPromise(
      deniedTools.tools
        .get("lz-project-read")!
        .execute(
          { paths: ["README.md"], level: "full" },
          callContext("ses_worker", "lazers-implementor"),
        ),
    ),
  ).rejects.toThrow("Permission denied")
  expect(f.sessionReads.length).toBe(before)
  expect(f.permissionReads.length).toBe(beforePermissions)

  const key = `${f.source}/README.md`
  f.denied.add(key)
  const tools = await register(f.workerIndex, f.worker)
  const manifest = await Effect.runPromise(
    tools.tools
      .get("lz-project-index")!
      .execute({ paths: ["README.md"] }, callContext("ses_worker", "lazers-implementor")),
  )
  const read = await Effect.runPromise(
    tools.tools
      .get("lz-project-read")!
      .execute(
        { paths: ["README.md"], level: "full" },
        callContext("ses_worker", "lazers-implementor"),
      ),
  )
  expect(manifest.output.files).toEqual([])
  expect(read.output.sources).toEqual([])
  expect(JSON.stringify([manifest.output, read.output])).not.toContain("README.md")
  expect(JSON.stringify([manifest.output, read.output])).not.toContain("published source")

  f.denied.delete(key)
  expect(
    (
      await Effect.runPromise(
        tools.tools
          .get("lz-project-read")!
          .execute(
            { paths: ["README.md"], level: "full" },
            callContext("ses_worker", "lazers-implementor"),
          ),
      )
    ).output.sources[0]!.text,
  ).toContain("published source")
  f.denied.add(key)
  expect(
    (
      await Effect.runPromise(
        tools.tools
          .get("lz-project-read")!
          .execute(
            { paths: ["README.md"], level: "full" },
            callContext("ses_worker", "lazers-implementor"),
          ),
      )
    ).output.sources,
  ).toEqual([])
})

test("focused native reads check only cached matches against the worker and publication workspace", async () => {
  const f = setup()
  for (let number = 0; number < 125; number++)
    writeFileSync(join(f.source, `unrelated-${number}.txt`), `unrelated ${number}`)
  await f.sourceIndex.refresh({ sessionID: "ses_architect", agent: "architect" })
  const tools = await register(f.workerIndex, f.worker)
  const index = tools.tools.get("lz-project-index")!
  const read = tools.tools.get("lz-project-read")!

  f.permissionReads.length = 0
  const manifest = await Effect.runPromise(
    index.execute(
      { paths: ["README.md", "README*"] },
      callContext("ses_worker", "lazers-implementor"),
    ),
  )
  expect(manifest.output.files.map((file: { path: string }) => file.path)).toEqual(["README.md"])
  expect(f.permissionReads).toEqual([
    { path: "README.md", workspace: f.source, agent: "lazers-implementor" },
  ])

  f.permissionReads.length = 0
  const evidence = await Effect.runPromise(
    read.execute(
      { paths: ["README.md", "src.ts"], search: "PUBLISHED SOURCE", level: "full" },
      callContext("ses_worker", "lazers-implementor"),
    ),
  )
  expect(evidence.output.sources.map((source: { path: string }) => source.path)).toEqual([
    "README.md",
  ])
  expect(f.permissionReads).toEqual([
    { path: "README.md", workspace: f.source, agent: "lazers-implementor" },
  ])

  f.permissionReads.length = 0
  const noMatch = await Effect.runPromise(
    read.execute(
      { paths: ["README.md", "src.ts"], search: "not present" },
      callContext("ses_worker", "lazers-implementor"),
    ),
  )
  expect(noMatch.output.sources).toEqual([])
  expect(f.permissionReads).toEqual([])
})

test("a worker reads its parent's pinned snapshot, not a later workspace publication", async () => {
  const f = setup()
  const selected = await f.sourceIndex.refresh({ sessionID: "ses_architect", agent: "architect" })
  writeFileSync(join(f.source, "README.md"), "later unrelated Architect publication\n")
  const later = await f.sourceIndex.refresh({
    sessionID: "ses_other_architect",
    agent: "architect",
  })
  expect(later.id).not.toBe(selected.id)
  const beforeRead = f.state()
  forbidIndexing(f.workerIndex)

  const result = await f.workerIndex.evidence(
    { sessionID: "ses_worker", agent: "lazers-implementor" },
    { paths: ["README.md"] },
  )
  expect(result).toMatchObject({ snapshotID: selected.id, workspace: f.source })
  expect(result.sources[0]!.text).toBe("published source from Architect\n")
  expect(result.sources[0]!.text).not.toContain("later unrelated")
  expect(f.state()).toEqual(beforeRead)
})

test("native identity remains usable when Session.Info omits its optional agent field", async () => {
  const f = setup()
  f.sessions.set("ses_architect", {
    id: "ses_architect",
    projectID: "project",
    directory: f.source,
  })
  const published = await f.sourceIndex.refresh({ sessionID: "ses_architect", agent: "architect" })
  f.sessions.set("ses_worker", {
    id: "ses_worker",
    parentID: "ses_architect",
    projectID: "project",
    directory: f.worker,
  })
  const result = await f.workerIndex.evidence(
    { sessionID: "ses_worker", agent: "lazers-implementor" },
    { paths: ["README.md"] },
  )
  expect(result).toMatchObject({ snapshotID: published.id, workspace: f.source })
  expect(result.sources[0]!.text).toContain("published source from Architect")
})

test("foreign projects and unrelated parent sessions cannot select another Architect's publication", async () => {
  const f = setup()
  await f.sourceIndex.refresh({ sessionID: "ses_architect", agent: "architect" })

  f.sessions.set("ses_foreign_architect", {
    id: "ses_foreign_architect",
    projectID: "foreign-project",
    directory: f.source,
    agent: "architect",
  })
  f.sessions.set("ses_foreign_worker", {
    id: "ses_foreign_worker",
    parentID: "ses_foreign_architect",
    projectID: "foreign-project",
    directory: f.worker,
    agent: "lazers-implementor",
  })
  const foreignHost: ContextHost = {
    projectID: "foreign-project",
    session: async (id) => f.sessions.get(id) ?? null,
  }
  const foreignRepository = new TaskRepository(f.database, f.source)
  const foreignIndex = new ProjectIndex(
    f.worker,
    f.cache,
    foreignRepository,
    async () => true,
    foreignHost,
  )
  try {
    await expect(
      foreignIndex.evidence(
        { sessionID: "ses_foreign_worker", agent: "lazers-implementor" },
        { paths: ["README.md"] },
      ),
    ).rejects.toBeInstanceOf(WorkspaceIndexUnavailable)
  } finally {
    foreignIndex.close()
    foreignRepository.close()
  }

  const otherCanonical = join(f.temp, "same-id-other-project")
  mkdirSync(otherCanonical)
  const sameIDRepository = new TaskRepository(f.database, otherCanonical)
  const sameIDIndex = new ProjectIndex(f.worker, f.cache, sameIDRepository, async () => true, {
    projectID: "project",
    session: async (id) => f.sessions.get(id) ?? null,
  })
  try {
    await expect(
      sameIDIndex.evidence(
        { sessionID: "ses_worker", agent: "lazers-implementor" },
        { paths: ["README.md"] },
      ),
    ).rejects.toBeInstanceOf(WorkspaceIndexUnavailable)
  } finally {
    sameIDIndex.close()
    sameIDRepository.close()
  }

  f.sessions.set("ses_unrelated_worker", {
    id: "ses_unrelated_worker",
    parentID: "ses_unrelated_architect",
    projectID: "project",
    directory: f.worker,
    agent: "lazers-implementor",
  })
  f.sessions.set("ses_unrelated_architect", {
    id: "ses_unrelated_architect",
    projectID: "project",
    directory: f.source,
    agent: "architect",
  })
  await expect(
    f.workerIndex.evidence(
      { sessionID: "ses_unrelated_worker", agent: "lazers-implementor" },
      { paths: ["README.md"] },
    ),
  ).rejects.toBeInstanceOf(WorkspaceIndexUnavailable)
})

test("unavailable optional context does not rebuild or prevent an ordinary source read", async () => {
  const f = setup()
  f.sessions.delete("ses_architect")
  forbidIndexing(f.workerIndex)
  await expect(
    f.workerIndex.evidence(
      { sessionID: "ses_worker", agent: "lazers-implementor" },
      { paths: ["README.md"] },
    ),
  ).rejects.toBeInstanceOf(WorkspaceIndexUnavailable)
  expect(readFileSync(join(f.worker, "README.md"), "utf8")).toBe("different live worker source\n")
  expect(f.state().files).toEqual([])
})
