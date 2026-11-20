import { expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { parseProfile } from "../projects/profile.ts"
import { confirmRevision, proposeRevision, type ProofRecord } from "../projects/profile-store.ts"
import {
  cleanup,
  deferred,
  drive,
  driveWithTaskSourceLandings,
  fixture,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

const profileOf = (raw: Record<string, unknown>) => {
  const parsed = parseProfile({ source: { include: ["src/**/*.rs"] }, ...raw })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.profile
}

/** Registers the fixture's checkout as a project and confirms a profile revision for it. */
async function confirm(
  f: ReturnType<typeof fixture>,
  raw: Record<string, unknown>,
  proofs: ProofRecord[] = [],
) {
  Bun.spawnSync(["git", "-C", f.root, "remote", "add", "origin", "git@h.com:a/p.git"])
  const { key } = await registerProject(f.repository, {
    directory: f.root,
    opencodeProjectID: "project",
  })
  const row = proposeRevision(f.repository, {
    projectKey: key,
    profile: profileOf(raw),
    author: { kind: "architect", sessionID: "s1", agent: "architect" },
    reason: "test",
    proofs,
  })
  confirmRevision(f.repository, { projectKey: key, revision: row.revision, by: "owner" })
  return { key, row }
}

/** A fake cargo in `HOME/.cargo/bin`, which is not on PATH; the fixture's checks inherit it. */
function fakeCargoHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-runtime-profile-")))
  const bin = join(root, "home", ".cargo", "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "cargo"), '#!/bin/sh\necho "cargo $*" >> "$MARKER"\nexit 0\n')
  chmodSync(join(bin, "cargo"), 0o755)
  const saved = { HOME: process.env.HOME, MARKER: process.env.MARKER, PATH: process.env.PATH }
  process.env.HOME = join(root, "home")
  process.env.MARKER = join(root, "marker")
  process.env.PATH = "/usr/bin:/bin"
  cleanup.push(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetProjectAliasCache()
  })
  return { root, marker: join(root, "marker") }
}

const verifyEffects = (f: ReturnType<typeof fixture>) =>
  f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "verify:content")
const checkOf = (effect: { receipt: string | null }) =>
  (JSON.parse(effect.receipt ?? "{}") as { check?: Record<string, any> }).check

const CARGO_CHECK = "cargo fmt --check && cargo test --locked"
const cargoProfile = {
  toolchains: ["cargo"],
  verify: [
    { id: "fmt", command: "cargo fmt --check" },
    { id: "tests", command: "cargo test --locked" },
  ],
}

test("with a confirmed profile a task check runs as phases with the profile's tools and records the revision", async () => {
  const cargo = fakeCargoHome()
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }], checkCommand: CARGO_CHECK })
  const { row } = await confirm(f, cargoProfile)
  await runPlan(f)
  await drive(f.runtime, 12)
  const [effect] = verifyEffects(f)
  const check = checkOf(effect!)!
  expect(check.exitCode).toBe(0)
  expect(check.phases.map((phase: { command: string }) => phase.command)).toEqual([
    "cargo fmt --check",
    "cargo test --locked",
  ])
  expect(readFileSync(cargo.marker, "utf8")).toBe("cargo fmt --check\ncargo test --locked\n")
  expect(JSON.parse(check.environmentIdentity).profile.revision).toBe(row.revision)
  expect(JSON.parse(effect!.payload).profileRevisionID).toBeNumber()
}, 30_000)

test("a revision confirmed while a check runs never disturbs it; the next verify effect uses the new one", async () => {
  fakeCargoHome()
  const f = fixture({
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
    ],
    checkCommand: CARGO_CHECK,
  })
  const { key } = await confirm(f, cargoProfile)
  const gate = deferred<void>()
  const runtime = f.runtime as unknown as {
    startCheckActivity: (input: { run(signal: AbortSignal): Promise<unknown> }) => unknown
  }
  const original = runtime.startCheckActivity.bind(f.runtime)
  let held = false
  runtime.startCheckActivity = (input) => {
    if (held) return original(input)
    held = true
    return original({
      ...input,
      run: async (signal: AbortSignal) => {
        await gate.promise
        return input.run(signal)
      },
    })
  }
  await runPlan(f)
  for (let n = 0; n < 6 && !held; n++) await f.runtime.tick()
  expect(held).toBe(true)
  const second = proposeRevision(f.repository, {
    projectKey: key,
    profile: profileOf({ ...cargoProfile, env: ["RUSTUP_HOME"] }),
    author: { kind: "architect", sessionID: "s1", agent: "architect" },
    reason: "second",
    proofs: [],
  })
  confirmRevision(f.repository, { projectKey: key, revision: second.revision, by: "owner" })
  gate.resolve()
  await driveWithTaskSourceLandings(f, 30)
  const effects = verifyEffects(f)
  expect(effects).toHaveLength(2)
  const [first, next] = effects.map((effect) => ({
    pinned: JSON.parse(effect.payload).profileRevisionID,
    identity: JSON.parse(checkOf(effect)!.environmentIdentity).profile.revision,
  }))
  expect(first!.identity).toBe(1)
  expect(next!.identity).toBe(2)
  expect(next!.pinned).not.toBe(first!.pinned)
  expect(f.store.plan(f.receipt.planID)?.state).not.toBe("blocked")
}, 60_000)

test("with no profile stored the same check is one unrecognised command and no revision is recorded", async () => {
  fakeCargoHome()
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }], checkCommand: CARGO_CHECK })
  await runPlan(f)
  await drive(f.runtime, 12)
  const [effect] = verifyEffects(f)
  expect(checkOf(effect!)!.phases).toBeUndefined()
  expect(JSON.parse(effect!.payload).profileRevisionID).toBeUndefined()
}, 30_000)
