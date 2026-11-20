import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseProfile } from "../../projects/profile.ts"
import { effectiveInstall } from "../../projects/toolchains.ts"
import { git } from "../artifacts.ts"
import {
  createRetainedCheckContext,
  observeRetainedCheckContext,
  retainedCheckIsolationWitness,
  retainedVerificationEnvironmentIdentity,
  type RetainedCheckProfile,
  type RetainedDependencyInstaller,
} from "./isolation.ts"
import { retainedProcedurePlan } from "./procedure.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A committed repository, a detached candidate worktree of it, and an owned state directory. */
function project(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-retained-profile-repo-")))
  const state = realpathSync(mkdtempSync(join(tmpdir(), "lazers-retained-profile-state-")))
  const candidate = join(state, "candidate")
  cleanups.push(() => {
    try {
      git(root, ["worktree", "remove", "--force", candidate])
    } catch {
      // Cleanup of a failed fixture.
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "baseline"])
  const artifact = git(root, ["rev-parse", "HEAD"])
  git(root, ["worktree", "add", "--detach", candidate, artifact])
  const taskDatabase = join(state, "tasks.sqlite")
  new Database(taskDatabase).close()
  return { root, state, candidate: realpathSync(candidate), artifact, taskDatabase }
}

function profileOf(value: Record<string, unknown>) {
  const parsed = parseProfile({ source: { include: ["src/**"] }, ...value })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.profile
}

async function context(
  p: ReturnType<typeof project>,
  command: string,
  extra: {
    profile?: RetainedCheckProfile
    dependencyInstaller?: RetainedDependencyInstaller
  },
) {
  const procedure = retainedProcedurePlan(command)
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  return createRetainedCheckContext({
    rootDirectory: p.state,
    operationID: crypto.randomUUID(),
    phase: "task",
    checkID: "profile-check",
    originalWorkspace: p.root,
    candidateWorkspace: p.candidate,
    taskDatabase: p.taskDatabase,
    projectDirectory: p.root,
    candidateArtifact: p.artifact,
    priorResourcePaths: [],
    procedurePlan: procedure.plan,
    ...extra,
  })
}

const cargoFiles = {
  "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
  "Cargo.lock": "version = 4\n",
  "src/lib.rs": "pub fn a() {}\n",
  // A stray manifest a cargo project must not be treated as a Node project for.
  "package.json": '{"name":"stray","version":"1.0.0"}\n',
}

test("without a profile the environment identity is today's string", () => {
  const parsed = JSON.parse(retainedVerificationEnvironmentIdentity())
  expect(Object.keys(parsed).sort()).toEqual(
    [
      "CI",
      "LANG",
      "LC_ALL",
      "PATH",
      "TZ",
      "architecture",
      "bunRevision",
      "bunVersion",
      "executable",
      "platform",
    ].sort(),
  )
  const withProfile = JSON.parse(
    retainedVerificationEnvironmentIdentity({
      revision: 4,
      toolchains: ["cargo"],
      env: ["CARGO_HOME"],
      toolVersions: {},
    }),
  )
  expect(withProfile.profile).toMatchObject({ revision: 4, env: ["CARGO_HOME"] })
})

test("a cargo profile links no node_modules, owns its build output and keeps its variables", async () => {
  const p = project(cargoFiles)
  const profile = profileOf({
    toolchains: ["cargo"],
    verify: [{ id: "tests", command: "cargo test --locked" }],
    env: ["CARGO_HOME", "RUSTUP_HOME"],
  })
  const ran: string[][] = []
  const ctx = await context(p, "cargo test --locked", {
    profile: {
      revisionID: 7,
      revision: 2,
      profile,
      installs: effectiveInstall(profile, p.candidate),
    },
    dependencyInstaller: async (input) => void ran.push(input.command ?? []),
  })
  expect(ran).toEqual([["cargo", "fetch", "--locked"]])
  expect(existsSync(join(p.candidate, "node_modules"))).toBe(false)
  expect(ctx.dependencyLink).toBeNull()
  const cache = ctx.resources.find((resource) => resource.name === "cache")!.realPath
  expect(ctx.environment.CARGO_TARGET_DIR).toBe(join(cache, "cargo-target"))
  expect(ctx.environment.CARGO_HOME).toBe(process.env.CARGO_HOME ?? join(homedir(), ".cargo"))
  expect(ctx.environment.RUSTUP_HOME).toBe(process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"))
  expect(ctx.environment.HOME).toBe(ctx.resources.find((r) => r.name === "home")!.realPath)
  expect(ctx.profileRevisionID).toBe(7)
  const witness = retainedCheckIsolationWitness(ctx)
  expect(witness).toMatchObject({ profileRevisionID: 7 })
  expect(JSON.stringify(witness)).not.toContain(ctx.environment.CARGO_HOME!)
  // Observation uses the context's pinned revision and reads nothing newer.
  expect(await observeRetainedCheckContext(ctx)).toBe(true)
})

test("an npm profile runs its proven hardened install and links node_modules as Bun does", async () => {
  const p = project({
    "package.json": '{"name":"n","version":"1.0.0","private":true}\n',
    "package-lock.json": "{}\n",
    "src/a.js": "export const a = 1\n",
  })
  const profile = profileOf({
    toolchains: ["npm"],
    verify: [{ id: "lint", command: "npm run lint" }],
  })
  const ran: string[][] = []
  const ctx = await context(p, "bun test", {
    profile: { revisionID: 1, profile, installs: effectiveInstall(profile, p.candidate) },
    dependencyInstaller: async (input) => void ran.push(input.command ?? []),
  })
  expect(ran).toEqual([["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]])
  expect(lstatSync(join(p.candidate, "node_modules")).isSymbolicLink()).toBe(true)
  expect(ctx.dependencyLink).not.toBeNull()
  expect(ctx.environment.CARGO_TARGET_DIR).toBeUndefined()
})

test("an install that is not proven never runs", async () => {
  const p = project(cargoFiles)
  const profile = profileOf({
    toolchains: ["cargo"],
    verify: [{ id: "t", command: "cargo test" }],
  })
  let called = false
  await context(p, "cargo test", {
    profile: { revisionID: 1, profile, installs: [] },
    dependencyInstaller: async () => void (called = true),
  })
  expect(called).toBe(false)
})

test("a failing profile install names its command and exit code", async () => {
  const p = project(cargoFiles)
  const profile = profileOf({
    toolchains: ["cargo"],
    verify: [{ id: "t", command: "cargo test" }],
    install: "echo setting up; exit 7",
  })
  await expect(
    context(p, "cargo test", {
      profile: { revisionID: 1, profile, installs: effectiveInstall(profile, p.candidate) },
    }),
  ).rejects.toThrow(/echo setting up; exit 7 exited with code 7/)
})
