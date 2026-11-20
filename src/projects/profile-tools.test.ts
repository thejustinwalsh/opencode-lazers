import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect } from "effect"
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
import type { z } from "zod"
import { deriveSourceDefinition } from "../context/repo-map.ts"
import { guidanceLedger, runbook } from "../guidance/index.ts"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { fakeTools } from "../../test/fixtures/profile/toolchain.ts"
import { registerProfileTools } from "./profile-tools.ts"
import { activeProfile, profileRevisions } from "./profile-store.ts"

type Registered = Parameters<ToolEditor["add"]>[0]
const cleanups: (() => void)[] = []
const savedPath = process.env.PATH
afterEach(() => {
  process.env.PATH = savedPath
  delete process.env.MARKER
  resetProjectAliasCache()
  guidanceLedger.clear()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function setup(options: { register?: boolean } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lazers-profile-tools-")))
  const root = join(parent, "project")
  mkdirSync(join(root, "src"), { recursive: true })
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args])
  git("init", "-q", "-b", "main")
  git("remote", "add", "origin", "git@h.com:a/t.git")
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  git("add", "-A")
  git("-c", "user.name=f", "-c", "user.email=f@e.invalid", "commit", "-q", "-m", "base")
  const repository = new TaskRepository(join(parent, "db.sqlite"), root)
  new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(parent, { recursive: true, force: true })
    rmSync(`${root}.worktrees`, { recursive: true, force: true })
  })
  if (options.register !== false)
    await registerProject(repository, { directory: root, opencodeProjectID: "p" })
  const tools = new Map<string, Registered>()
  const actions: string[] = []
  const ctx = {
    location: { directory: root },
    tool: {
      transform: (run: (editor: ToolEditor) => void) =>
        Effect.sync(() => run({ add: (tool: Registered) => tools.set(tool.name, tool) } as never)),
    },
    permission: {
      assert: (input: { action: string }) => {
        actions.push(input.action)
        return Effect.void
      },
    },
  } as unknown as Plugin.Context
  await Effect.runPromise(
    Effect.scoped(
      registerProfileTools(ctx, repository, {
        dataDirectory: join(parent, "data"),
        workspace: {
          async create({ base, name }) {
            const target = join(`${root}.worktrees`, name)
            mkdirSync(`${root}.worktrees`, { recursive: true })
            git("worktree", "add", "--detach", target, base)
            return target
          },
          async remove(target) {
            git("worktree", "remove", "--force", target)
          },
        },
      }),
    ),
  )
  const tool = tools.get("lz-project-profile")!
  const invoke = async (input: unknown, sessionID = "ses_a") => {
    const parsed = (tool.input as z.ZodType).parse(input)
    const result = await Effect.runPromise(
      tool.execute(parsed, {
        sessionID,
        agent: "architect",
        messageID: "m",
        id: "c",
        progress: () => Effect.void,
      } as never),
    )
    return result.output as Record<string, any>
  }
  return { repository, root, parent, tool, invoke, actions }
}

const good = {
  verify: [{ id: "tests", command: "cargo test" }],
  toolchains: ["cargo"],
  source: { include: ["src/**/*.ts"] },
}

test("show on a fresh project lists the derived source and the hardened installs", async () => {
  const f = await setup()
  const out = await f.invoke({})
  expect(out.active).toBeUndefined()
  expect(out.derivedSource).toEqual(await deriveSourceDefinition(f.root))
  expect(out.hardenedInstalls.bun).toBe("bun install --ignore-scripts --no-save --no-progress")
  expect(out.hardenedInstalls.cargo).toBe("cargo fetch --locked")
  expect(out.fallowConfig).toEqual({ repositoryFile: false, stored: false })
  expect(f.actions).toContain("lz-project-profile")
})

test("an unregistered project is refused", async () => {
  const f = await setup({ register: false })
  expect(await f.invoke({})).toEqual({ refused: "PROJECT_NOT_REGISTERED" })
})

test("set with an invalid profile is refused with its issues and stores nothing", async () => {
  const f = await setup()
  const out = await f.invoke({ mode: "set", profile: { ...good, verify: [] }, reason: "x" })
  expect(out.refused).toBe("PROFILE_INVALID")
  expect(out.issues[0].code).toBe("VERIFY_EMPTY")
  const key = (await f.invoke({})).projectKey
  expect(profileRevisions(f.repository, key)).toEqual([])
})

test("a tool call makes the profile active and readable at once, and a failing command is recorded as failing", async () => {
  const f = await setup()
  const marker = join(f.parent, "marker")
  const tools = fakeTools({
    cargo:
      '#!/bin/sh\ncase "$1" in --version) echo cargo 9;; fetch) ;; test) echo ran > "$MARKER"; exit 3;; esac\n',
  })
  cleanups.push(tools.cleanup)
  process.env.MARKER = marker
  process.env.PATH = `${tools.bin}:${process.env.PATH}`
  expect(activeProfile(f.repository, f.root)).toBeUndefined()
  const first = await f.invoke({ mode: "set", profile: good, reason: "first" })
  expect(first).toMatchObject({ revision: 1, state: "active" })
  // Read straight away, with no step in between.
  expect(activeProfile(f.repository, f.root)).toMatchObject({ revision: 1 })
  const proof = first.proofs.find((p: { key: string }) => p.key === "verify:tests")
  expect(proof).toMatchObject({ outcome: "failed", exitCode: 3, command: "cargo test" })
  expect(existsSync(marker)).toBe(true)
  expect(readFileSync(marker, "utf8").trim()).toBe("ran")
  expect(first.next).toContain("active now")
  expect(JSON.stringify(first)).not.toMatch(/propos|pending|not active|confirm/i)
  expect(first.guidance).toBe(runbook("project-setup"))
  // The old mode name still works, and the next revision supersedes this one.
  const second = await f.invoke({ mode: "propose", profile: good, reason: "again" })
  expect(second.revision).toBe(2)
  expect(second.guidance).toContain("guidance was delivered earlier")
  const key = (await f.invoke({})).projectKey
  expect(
    Object.fromEntries(profileRevisions(f.repository, key).map((r) => [r.revision, r.state])),
  ).toEqual({ 1: "superseded", 2: "active" })
  expect(activeProfile(f.repository, f.root)?.revision).toBe(2)
})

test("show returns the active profile", async () => {
  const f = await setup()
  await f.invoke({ mode: "set", profile: { ...good, toolchains: [] }, reason: "x" })
  const shown = await f.invoke({})
  expect(shown.active).toMatchObject({ revision: 1, state: "active" })
  expect(shown).not.toHaveProperty("pending")
})

test("no mode confirms a profile; there is nothing to confirm", async () => {
  const f = await setup()
  expect(() => (f.tool.input as z.ZodType).parse({ mode: "confirm" })).toThrow()
})

test("guide returns the runbook", async () => {
  const f = await setup()
  expect((await f.invoke({ mode: "guide" })).guidance).toBe(runbook("project-setup"))
})
