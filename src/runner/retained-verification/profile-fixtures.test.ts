import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureRepo, requireToolchain } from "../../../test/fixtures/profile/toolchain.ts"
import { checkRunProfile } from "../../projects/profile-runtime.ts"
import { parseProfile, type ProjectProfile } from "../../projects/profile.ts"
import { proveProfile, type ProofWorkspace } from "../../projects/profile-proof.ts"
import type { ActiveProfile } from "../../projects/profile-store.ts"
import { effectiveInstall } from "../../projects/toolchains.ts"
import { git, runDeclaredCheck } from "../artifacts.ts"
import { checkFailureReason } from "../checks.ts"
import { createRetainedCheckContext, type RetainedCheckProfile } from "./isolation.ts"
import { retainedProcedurePlan } from "./procedure.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]

function temp(prefix: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const profileOf = (value: Record<string, unknown>): ProjectProfile => {
  const parsed = parseProfile(value)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.profile
}

/** The worktree stand-in the proof uses: detached, non-forced removal. */
function workspace(root: string): ProofWorkspace {
  const parent = `${root}.worktrees`
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }))
  return {
    async create({ base, name }) {
      const target = join(parent, name)
      mkdirSync(parent, { recursive: true })
      git(root, ["worktree", "add", "--detach", target, base])
      return target
    },
    async remove(target) {
      git(root, ["worktree", "remove", "--force", target])
    },
  }
}

/** The profile as the runtime would hold it after confirmation: proofs from a real proof run. */
async function confirmed(root: string, profile: ProjectProfile): Promise<ActiveProfile> {
  const proof = await proveProfile({
    projectDirectory: root,
    dataDirectory: temp("lazers-fixtures-data-"),
    profile,
    workspace: workspace(root),
  })
  return {
    revisionID: 1,
    revision: 1,
    projectKey: "k",
    profile,
    confirmedAt: 1,
    proofs: new Map(proof.proofs.map((entry) => [entry.key, entry])),
  }
}

/** A candidate worktree at `artifact`, then the isolated context for `command` with the profile. */
async function recheck(
  root: string,
  artifact: string,
  active: ActiveProfile,
  command: string,
  profileOverride?: Partial<RetainedCheckProfile>,
) {
  const state = temp("lazers-fixtures-state-")
  const candidate = join(state, "candidate")
  git(root, ["worktree", "add", "--detach", candidate, artifact])
  cleanups.push(() => {
    try {
      git(root, ["worktree", "remove", "--force", candidate])
    } catch {
      // Already removed with its state directory.
    }
  })
  const taskDatabase = join(state, "tasks.sqlite")
  writeFileSync(taskDatabase, "")
  const procedure = retainedProcedurePlan(command)
  if (procedure.status !== "supported") throw new Error(procedure.reason)
  const installs = effectiveInstall(active.profile, candidate).filter(
    (_, index) => active.proofs.get(`install:${index}`)?.outcome === "proven",
  )
  const context = await createRetainedCheckContext({
    rootDirectory: state,
    operationID: crypto.randomUUID(),
    phase: "task",
    checkID: "fixture-check",
    originalWorkspace: root,
    candidateWorkspace: realpathSync(candidate),
    taskDatabase,
    projectDirectory: root,
    candidateArtifact: artifact,
    priorResourcePaths: [],
    procedurePlan: procedure.plan,
    profile: {
      revisionID: active.revisionID,
      profile: active.profile,
      installs,
      ...profileOverride,
    },
  })
  const run = (check: string) =>
    runDeclaredCheck(
      context.candidateWorkspace,
      artifact,
      { id: "fixture-check", command: check },
      join(state, "receipt.json"),
      { environment: context.environment, profile: checkRunProfile(active) },
    )
  return { context, run, candidate: context.candidateWorkspace }
}

/** A proof that did not pass fails with what it printed, so a gate failure explains itself. */
function expectProven(active: ActiveProfile, key: string) {
  const proof = active.proofs.get(key)
  expect(
    proof?.outcome,
    `${key}: ${proof?.reason ?? ""} exit ${proof?.exitCode} stderr: ${proof?.stderrTail} stdout: ${proof?.stdoutTail}`,
  ).toBe("proven")
}

const cargoAvailable = requireToolchain("cargo", "isolated recheck of the cargo-min fixture")
test.skipIf(!cargoAvailable)(
  "real cargo: the isolated recheck passes, then fails a broken candidate with exit 101",
  async () => {
    const fixture = fixtureRepo("cargo-min")
    cleanups.push(fixture.cleanup)
    const active = await confirmed(
      fixture.root,
      profileOf({
        toolchains: ["cargo"],
        verify: [
          { id: "fmt", command: "cargo fmt --check" },
          { id: "tests", command: "cargo test --locked" },
        ],
        env: ["CARGO_HOME", "RUSTUP_HOME"],
        audit: "off",
        source: { include: ["src/**/*.rs"] },
      }),
    )
    expectProven(active, "install:0")
    const good = await recheck(
      fixture.root,
      fixture.base,
      active,
      "cargo fmt --check && cargo test --locked",
    )
    const passed = await good.run("cargo fmt --check && cargo test --locked")
    expect(passed.exitCode).toBe(0)
    expect(passed.phases).toHaveLength(2)
    expect(existsSync(join(good.candidate, "target"))).toBe(false)
    expect(existsSync(join(good.candidate, "node_modules"))).toBe(false)

    const lib = join(fixture.root, "src/lib.rs")
    writeFileSync(lib, readFileSync(lib, "utf8").replace("2, 2), 4)", "2, 2), 5)"))
    git(fixture.root, ["add", "-A"])
    git(fixture.root, [...IDENTITY, "commit", "-m", "break the test"])
    const broken = await recheck(
      fixture.root,
      git(fixture.root, ["rev-parse", "HEAD"]),
      active,
      "cargo test --locked",
    )
    const failed = await broken.run("cargo test --locked")
    expect(failed.exitCode).toBe(101)
    expect(checkFailureReason(failed)).toContain("exited with code 101")
    expect(existsSync(join(broken.candidate, "target"))).toBe(false)
  },
)

const npmAvailable = requireToolchain(
  "npm-cache",
  "isolated recheck of the npm-eslint-vitest fixture",
)
test.skipIf(!npmAvailable)(
  "real npm: the isolated recheck passes, then fails a lint error",
  async () => {
    const fixture = fixtureRepo("npm-eslint-vitest")
    cleanups.push(fixture.cleanup)
    // The isolated recheck has its own npm cache, so the install reads the seeded one offline.
    const cache = Bun.spawnSync(["npm", "config", "get", "cache"]).stdout.toString().trim()
    const profile = profileOf({
      toolchains: ["npm"],
      verify: [
        { id: "lint", command: "npm run lint" },
        { id: "tests", command: "npx --no-install vitest run" },
      ],
      install: `npm ci --offline --ignore-scripts --no-audit --no-fund --cache '${cache}'`,
      audit: "off",
      source: { include: ["src/**/*.js"] },
    })
    const active = await confirmed(fixture.root, profile)
    expectProven(active, "install:0")
    const good = await recheck(fixture.root, fixture.base, active, "npm run lint")
    const link = join(good.candidate, "node_modules")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(
      join(good.context.resources.find((r) => r.name === "dependencies")!.realPath),
    )
    expect((await good.run("npm run lint")).exitCode).toBe(0)
    expect((await good.run("npx --no-install vitest run")).exitCode).toBe(0)

    writeFileSync(
      join(fixture.root, "src/sum.js"),
      "export const unused = 1\nvar x = 1\nexport function sum(a, b) {\n  return a + b\n}\n",
    )
    git(fixture.root, ["add", "-A"])
    git(fixture.root, [...IDENTITY, "commit", "-m", "lint error"])
    const bad = await recheck(
      fixture.root,
      git(fixture.root, ["rev-parse", "HEAD"]),
      active,
      "npm run lint",
    )
    const failed = await bad.run("npm run lint")
    expect(failed.exitCode).not.toBe(0)
  },
)

test("Bun: the hardened install argv is today's and the profile's format check passes", async () => {
  const root = temp("lazers-fixtures-bun-")
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "b", version: "1.0.0", private: true }, null, 2)}\n`,
  )
  writeFileSync(join(root, "bun.lock"), "{}\n")
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n")
  git(root, ["init", "--initial-branch=main"])
  git(root, ["add", "-A"])
  git(root, [...IDENTITY, "commit", "-m", "baseline"])
  const lazers = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../test/fixtures/profile/lazers.profile.json"),
      "utf8",
    ),
  )
  const profile = profileOf(lazers)
  const base = git(root, ["rev-parse", "HEAD"])
  const [install] = effectiveInstall(profile, root)
  expect(install).toEqual({
    source: "hardened-default",
    toolchain: "bun",
    argv: ["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--no-save", "--no-progress"],
  })
  const active: ActiveProfile = {
    revisionID: 1,
    revision: 1,
    projectKey: "k",
    profile,
    confirmedAt: 1,
    proofs: new Map(),
  }
  // The recorded argv is the proof of today's install; running it needs a real lockfile.
  const { run } = await recheck(root, base, active, "bun fmt --check", { installs: [] })
  const fmt = await run("bun fmt --check")
  expect(fmt.exitCode).toBe(0)
}, 120_000)
