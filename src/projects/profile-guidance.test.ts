import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { TaskRepository } from "../storage.ts"
import { parseProfile } from "./profile.ts"
import { confirmRevision, proposeRevision } from "./profile-store.ts"
import { architectProfileKey, ensureArchitectProfileGuidance } from "./profile-guidance.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  resetProjectAliasCache()
  for (const clean of cleanup.splice(0)) clean()
})

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-profile-guidance-")))
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", "git@h.com:a/g.git"],
  ])
    Bun.spawnSync(["git", "-C", root, ...args])
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const { key } = await registerProject(repository, { directory: root, opencodeProjectID: "p" })
  const agents = new Map<string, string>()
  const entries = new Map<string, Map<string, string>>()
  const puts: string[] = []
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.succeed({
        id: sessionID,
        agent: agents.get(sessionID),
        location: { directory: root },
      }),
    instructions: {
      entry: {
        list: ({ sessionID }: { sessionID: string }) =>
          Effect.succeed(
            [...(entries.get(sessionID) ?? new Map())].map(([k, value]) => ({ key: k, value })),
          ),
        put: ({ sessionID, key: k, value }: { sessionID: string; key: string; value: string }) =>
          Effect.sync(() => {
            puts.push(sessionID)
            entries.set(sessionID, (entries.get(sessionID) ?? new Map()).set(k, value))
          }),
      },
    },
  }
  const confirm = () => {
    const parsed = parseProfile({
      toolchains: ["cargo"],
      verify: [{ id: "tests", command: "cargo test --locked" }],
      source: { include: ["src/**/*.rs"] },
    })
    if (!parsed.ok) throw new Error("bad fixture")
    proposeRevision(repository, {
      projectKey: key,
      profile: parsed.profile,
      author: { kind: "owner" },
      reason: "t",
      proofs: [],
    })
    confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })
  }
  return {
    repository,
    agents,
    entries,
    puts,
    confirm,
    session: session as unknown as Plugin.Context["session"],
  }
}

test("an Architect session of a profiled project gets the guidance once", async () => {
  const f = await fixture()
  f.confirm()
  f.agents.set("ses_a1", "architect")
  expect(await ensureArchitectProfileGuidance(f.session, f.repository, "ses_a1")).toBe(true)
  expect(await ensureArchitectProfileGuidance(f.session, f.repository, "ses_a1")).toBe(false)
  expect(f.puts).toEqual(["ses_a1"])
  const text = f.entries.get("ses_a1")!.get(architectProfileKey)!
  expect(text).toContain("## Project verification (profile revision 1)")
  expect(text).toContain("- tests: cargo test --locked (unproven: not proven)")
  expect(text).toContain("Audit: Fallow.")
})

test("with no profile nothing is installed, and a later profile still installs", async () => {
  const f = await fixture()
  f.agents.set("ses_a2", "architect")
  expect(await ensureArchitectProfileGuidance(f.session, f.repository, "ses_a2")).toBe(false)
  expect(f.puts).toEqual([])
  f.confirm()
  expect(await ensureArchitectProfileGuidance(f.session, f.repository, "ses_a2")).toBe(true)
})

test("workers are skipped, and an existing entry is left alone", async () => {
  const f = await fixture()
  f.confirm()
  f.agents.set("ses_w", "lazers-implementor")
  expect(await ensureArchitectProfileGuidance(f.session, f.repository, "ses_w")).toBe(false)
  f.agents.set("ses_a3", "architect")
  f.entries.set("ses_a3", new Map([[architectProfileKey, "existing"]]))
  expect(await ensureArchitectProfileGuidance(f.session, f.repository, "ses_a3")).toBe(false)
  expect(f.puts).toEqual([])
})
