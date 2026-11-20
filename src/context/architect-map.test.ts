import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../runner/artifacts.ts"
import { nativeHost } from "../runner/native.ts"
import { TaskRepository } from "../storage.ts"
import { architectMapKey, ensureArchitectMap } from "./architect-map.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-architect-map-"))
  git(root, ["init", "--initial-branch=main"])
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const agents = new Map<string, string>()
  const entries = new Map<string, Map<string, string>>()
  const puts: { sessionID: string; key: string }[] = []
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.succeed({
        id: sessionID,
        agent: agents.get(sessionID),
        location: { directory: root },
      }),
    create: (input: { id: string; agent: string }) =>
      Effect.sync(() => {
        agents.set(input.id, input.agent)
      }),
    instructions: {
      entry: {
        list: ({ sessionID }: { sessionID: string }) =>
          Effect.succeed(
            [...(entries.get(sessionID) ?? new Map())].map(([key, value]) => ({ key, value })),
          ),
        put: ({ sessionID, key, value }: { sessionID: string; key: string; value: string }) =>
          Effect.sync(() => {
            puts.push({ sessionID, key })
            entries.set(sessionID, (entries.get(sessionID) ?? new Map()).set(key, value))
          }),
      },
    },
  }
  return {
    root,
    repository,
    agents,
    entries,
    puts,
    session: session as unknown as Plugin.Context["session"],
  }
}

test("an Architect session gets the map once, and repeated prompts do not resend it", async () => {
  const f = fixture()
  f.agents.set("ses_architect1", "architect")
  expect(await ensureArchitectMap(f.session, f.repository, "ses_architect1")).toBe(true)
  expect(await ensureArchitectMap(f.session, f.repository, "ses_architect1")).toBe(false)
  await Promise.all(
    [1, 2, 3].map(() => ensureArchitectMap(f.session, f.repository, "ses_architect1")),
  )
  expect(f.puts).toEqual([{ sessionID: "ses_architect1", key: architectMapKey }])
  const text = f.entries.get("ses_architect1")!.get(architectMapKey)!
  expect(text).toContain("## Repository map")
  expect(text).toContain("as of session start")
  expect(text).toContain("src/a.ts: const a")
  const row = f.repository.read((db) =>
    db
      .query<{ role: string; map_hash: string; map_tokens: number }, []>(
        "SELECT role,map_hash,map_tokens FROM repo_map_deliveries WHERE session_id='ses_architect1'",
      )
      .get(),
  )
  expect(row).toMatchObject({ role: "architect" })
  expect(row!.map_tokens).toBeGreaterThan(0)
})

test("workers and other agents are skipped", async () => {
  const f = fixture()
  f.agents.set("ses_worker", "lazers-implementor")
  expect(await ensureArchitectMap(f.session, f.repository, "ses_worker")).toBe(false)
  expect(f.puts).toEqual([])
})

test("a session that already holds the entry, as after a restart, is left alone", async () => {
  const f = fixture()
  f.agents.set("ses_architect2", "architect")
  f.entries.set("ses_architect2", new Map([[architectMapKey, "existing"]]))
  expect(await ensureArchitectMap(f.session, f.repository, "ses_architect2")).toBe(false)
  expect(f.puts).toEqual([])
})

test("creating a renewed Architect session installs the map before any prompt", async () => {
  const f = fixture()
  const context = {
    app: { version: "2.2.5" },
    location: { directory: f.root, project: { id: "project" } },
    session: f.session,
  } as unknown as Plugin.Context
  ;(context.session as unknown as { create: unknown }).create = (input: { id: string }) =>
    Effect.sync(() => {
      f.agents.set(input.id, "architect")
    })
  const host = nativeHost(context, f.repository)
  for (const id of ["ses_renewed1", "ses_renewed2"])
    await host.createArchitect({
      id,
      directory: f.root,
      title: "continue",
      planID: "plan",
      sourceSessionID: "source",
    })
  expect(f.puts.map((put) => put.sessionID)).toEqual(["ses_renewed1", "ses_renewed2"])
  // The first prompt of a renewed session finds the entry and adds nothing.
  expect(await ensureArchitectMap(f.session, f.repository, "ses_renewed1")).toBe(false)
  expect(f.puts).toHaveLength(2)
})
