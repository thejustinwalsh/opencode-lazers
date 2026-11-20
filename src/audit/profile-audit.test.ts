import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { z } from "zod"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { parseProfile } from "../projects/profile.ts"
import { confirmRevision, proposeRevision } from "../projects/profile-store.ts"
import { TaskRepository } from "../storage.ts"
import { fallowConfigGate } from "./fallow-gate.ts"
import { changedAuditFiles } from "./review-git.ts"
import { registerAuditTools } from "./tools.ts"

type Registered = Parameters<ToolEditor["add"]>[0]
const cleanups: (() => void)[] = []
afterEach(() => {
  resetProjectAliasCache()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function project(audit: "fallow" | "off" | undefined) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lazers-profile-audit-")))
  const root = join(parent, "project")
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "test"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  git(root, "init", "-q", "-b", "main")
  git(root, "remote", "add", "origin", "git@h.com:a/audit.git")
  git(root, "add", "-A")
  git(root, "-c", "user.name=f", "-c", "user.email=f@e.invalid", "commit", "-q", "-m", "base")
  const base = git(root, "rev-parse", "HEAD")
  const repository = new TaskRepository(join(parent, "db.sqlite"), root)
  cleanups.push(() => {
    repository.close()
    rmSync(parent, { recursive: true, force: true })
  })
  const { key } = await registerProject(repository, { directory: root, opencodeProjectID: "p" })
  if (audit) {
    const parsed = parseProfile({
      verify: [{ id: "t", command: "true" }],
      audit,
      source: { include: ["src/**/*.ts"], exclude: [] },
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
  return { root, base, repository }
}

const source = { include: ["src/**/*.ts"], exclude: [] }

test("with a source, only changes inside it are relevant; config files always are", async () => {
  const f = await project(undefined)
  writeFileSync(join(f.root, "test", "a.test.ts"), "export const t = 1\n")
  expect(await changedAuditFiles(f.root, f.base, source)).toEqual([])
  writeFileSync(join(f.root, "src", "a.ts"), "export const a = 2\n")
  expect(await changedAuditFiles(f.root, f.base, source)).toEqual(["src/a.ts"])
  writeFileSync(join(f.root, "package.json"), "{}\n")
  expect((await changedAuditFiles(f.root, f.base, source)).sort()).toEqual([
    "package.json",
    "src/a.ts",
  ])
})

test("without a source today's filter applies, and a non-readable language is never relevant", async () => {
  const f = await project(undefined)
  writeFileSync(join(f.root, "test", "a.test.ts"), "export const t = 1\n")
  writeFileSync(join(f.root, "src", "lib.rs"), "pub fn a() {}\n")
  expect(await changedAuditFiles(f.root, f.base)).toEqual(["test/a.test.ts"])
  expect(await changedAuditFiles(f.root, f.base, { include: ["src/**"], exclude: [] })).toEqual([])
})

test("the Fallow config gate: off needs no config, fallow or no profile keeps the demand", async () => {
  for (const [audit, refused] of [
    ["off", false],
    ["fallow", true],
    [undefined, true],
  ] as const) {
    const f = await project(audit)
    const gate = await fallowConfigGate({
      enabled: true,
      directory: f.root,
      repository: f.repository,
    })
    expect(gate !== undefined, String(audit)).toBe(refused)
  }
  const f = await project("fallow")
  expect(
    await fallowConfigGate({
      enabled: true,
      audit: "off",
      directory: f.root,
      repository: f.repository,
    }),
  ).toBeUndefined()
})

test("lz-fallow-config refuses suggest and dry-run under audit off, and still serves guide", async () => {
  const f = await project("off")
  const tools = new Map<string, Registered>()
  const ctx = {
    location: { directory: f.root },
    tool: {
      transform: (run: (editor: ToolEditor) => void) =>
        Effect.sync(() => run({ add: (tool: Registered) => tools.set(tool.name, tool) } as never)),
    },
    permission: { assert: () => Effect.void },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerAuditTools(ctx, f.repository)))
  const tool = tools.get("lz-fallow-config")!
  const invoke = async (input: unknown) => {
    const parsed = (tool.input as z.ZodType).parse(input)
    const result = await Effect.runPromise(
      tool.execute(parsed, {
        sessionID: "s",
        agent: "architect",
        messageID: "m",
        id: "c",
        progress: () => Effect.void,
      } as never),
    )
    return result.output as Record<string, unknown>
  }
  for (const mode of ["suggest", "dry-run"])
    expect(await invoke({ mode })).toMatchObject({ refused: "PROFILE_AUDIT_OFF" })
  expect(await invoke({ mode: "guide" })).toHaveProperty("guidance")
  expect(await invoke({ mode: "show" })).not.toHaveProperty("refused")
})
