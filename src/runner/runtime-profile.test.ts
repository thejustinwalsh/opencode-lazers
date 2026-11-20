import { expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fakeTools, fixtureRepo, requireToolchain } from "../../test/fixtures/profile/toolchain.ts"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { parseProfile } from "../projects/profile.ts"
import { activateRevision, type ProofRecord } from "../projects/profile-store.ts"
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

const proof = (key: string, outcome: ProofRecord["outcome"] = "proven"): ProofRecord => ({
  key,
  command: key,
  outcome,
  exitCode: outcome === "proven" ? 0 : 1,
  timedOut: false,
  durationMs: 1,
  stdoutTail: "",
  stderrTail: "",
  ranAt: 1,
})

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
  const row = activateRevision(f.repository, {
    projectKey: key,
    profile: profileOf(raw),
    author: { kind: "architect", sessionID: "s1", agent: "architect" },
    reason: "test",
    proofs,
  })
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

test("a project whose profile turns the audit off is accepted with no Fallow review and no hold", async () => {
  fakeCargoHome()
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: CARGO_CHECK,
    fallowConfig: "none",
  })
  await confirm(f, { ...cargoProfile, audit: "off" })
  await runPlan(f)
  await drive(f.runtime, 14)
  const planID = f.receipt.planID
  expect(f.store.plan(planID)?.state).not.toBe("blocked")
  expect(f.store.effects(planID).some((effect) => effect.kind === "verify:fallow-audit")).toBe(
    false,
  )
  expect(f.store.nodes(planID).every((node) => node.state === "accepted")).toBe(true)
})

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
})

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
  const second = activateRevision(f.repository, {
    projectKey: key,
    profile: profileOf({ ...cargoProfile, env: ["RUSTUP_HOME"] }),
    author: { kind: "architect", sessionID: "s1", agent: "architect" },
    reason: "second",
    proofs: [],
  })
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
})

test("with no profile stored the same check is one unrecognised command and no revision is recorded", async () => {
  fakeCargoHome()
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }], checkCommand: CARGO_CHECK })
  await runPlan(f)
  await drive(f.runtime, 12)
  const [effect] = verifyEffects(f)
  expect(checkOf(effect!)!.phases).toBeUndefined()
  expect(JSON.parse(effect!.payload).profileRevisionID).toBeUndefined()
})

/** Fix scripts: each argument gets `// fixed`; `other` also writes a file it was not given. */
function fixers() {
  const tools = fakeTools({
    "fixer.sh": 'for f in "$@"; do echo "// fixed" >> "$f"; done',
    "fixer2.sh": 'for f in "$@"; do echo "// fixed twice" >> "$f"; done',
    "fail.sh": "exit 1",
    "second.sh": 'echo ran >> "$SECOND_MARKER"',
    "other.sh": 'for f in "$@"; do echo "// fixed" >> "$f"; done\necho x > other.rs',
  })
  cleanup.push(tools.cleanup)
  return tools.bin
}

const rustTask = { name: "a", path: "src/lib.rs" }
const fixFixture = (extra: Parameters<typeof fixture>[0] = {}) =>
  fixture({
    taskFiles: [rustTask],
    checkCommand: "cargo fmt --check",
    writes: [{ path: "README.md", content: "readme\n" }],
    ...extra,
  })
const fixProfile = (fix: unknown[]) => ({
  toolchains: ["cargo"],
  verify: [{ id: "fmt", command: "cargo fmt --check" }],
  fix,
})
const preparation = (f: ReturnType<typeof fixture>) =>
  f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "mechanical-fix")
const workspaceOf = (f: ReturnType<typeof fixture>) =>
  f.store.attempts(f.receipt.planID)[0]!.workspace

test("the profile's fix runs on the changed files its globs select, and nothing else changes", async () => {
  fakeCargoHome()
  const bin = fixers()
  const f = fixFixture()
  await confirm(f, fixProfile([{ command: join(bin, "fixer.sh"), files: ["**/*.rs"] }]), [
    proof("fix:0"),
  ])
  await runPlan(f)
  await drive(f.runtime, 14)
  const [effect] = preparation(f)
  expect(JSON.parse(effect!.payload).command).toBe(`${join(bin, "fixer.sh")} 'src/lib.rs'`)
  expect(JSON.parse(effect!.payload).fixSteps).toHaveLength(1)
  expect(readFileSync(join(workspaceOf(f), "src/lib.rs"), "utf8")).toContain("// fixed")
  expect(readFileSync(join(workspaceOf(f), "README.md"), "utf8")).toBe("readme\n")
})

test("the first failing fix entry holds the plan and the next entry never runs", async () => {
  fakeCargoHome()
  const bin = fixers()
  const marker = join(bin, "second-marker")
  process.env.SECOND_MARKER = marker
  cleanup.push(() => {
    delete process.env.SECOND_MARKER
  })
  const f = fixFixture()
  await confirm(
    f,
    fixProfile([{ command: join(bin, "fail.sh") }, { command: join(bin, "second.sh") }]),
    [proof("fix:0"), proof("fix:1")],
  )
  await runPlan(f)
  await drive(f.runtime, 14)
  expect(f.store.plan(f.receipt.planID)?.reason).toContain(join(bin, "fail.sh"))
  expect(Bun.file(marker).size).toBe(0)
})

test("a fix entry whose proof failed is not in the chain", async () => {
  fakeCargoHome()
  const bin = fixers()
  const f = fixFixture()
  await confirm(
    f,
    fixProfile([{ command: join(bin, "fixer.sh") }, { command: join(bin, "fixer2.sh") }]),
    [proof("fix:0"), proof("fix:1", "failed")],
  )
  await runPlan(f)
  await drive(f.runtime, 14)
  const [effect] = preparation(f)
  expect(JSON.parse(effect!.payload).fixSteps.map((step: { index: number }) => step.index)).toEqual(
    [0],
  )
  expect(readFileSync(join(workspaceOf(f), "src/lib.rs"), "utf8")).not.toContain("twice")
})

test("a fix that changes a file it was not given holds the plan", async () => {
  fakeCargoHome()
  const bin = fixers()
  const f = fixFixture()
  await confirm(f, fixProfile([{ command: join(bin, "other.sh"), files: ["src/**"] }]), [
    proof("fix:0"),
  ])
  await runPlan(f)
  await drive(f.runtime, 14)
  console.log(
    preparation(f).map((e) => [e.state, e.payload.slice(0, 400), (e.receipt ?? "").slice(0, 600)]),
  )
  expect(f.store.plan(f.receipt.planID)?.reason).toContain(
    "Mechanical candidate preparation changed files it was not given: other.rs",
  )
})

test("a later revision with another fix command never changes a running preparation or its replay", async () => {
  fakeCargoHome()
  const bin = fixers()
  const f = fixFixture()
  const { key } = await confirm(
    f,
    fixProfile([{ command: join(bin, "fixer.sh"), files: ["**/*.rs"] }]),
    [proof("fix:0")],
  )
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
  for (let n = 0; n < 8 && !held; n++) await f.runtime.tick()
  expect(held).toBe(true)
  const second = activateRevision(f.repository, {
    projectKey: key,
    profile: profileOf(fixProfile([{ command: join(bin, "fixer2.sh"), files: ["**/*.rs"] }])),
    author: { kind: "architect", sessionID: "s1", agent: "architect" },
    reason: "second",
    proofs: [proof("fix:0")],
  })
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.reason ?? "").not.toContain("inputs changed")
  gate.resolve()
  await drive(f.runtime, 14)
  const [effect] = preparation(f)
  expect(checkOf(effect!)!.command).toBe(`${join(bin, "fixer.sh")} 'src/lib.rs'`)
  expect(f.store.plan(f.receipt.planID)?.reason ?? "").not.toContain("inputs changed")
})

test.skipIf(!requireToolchain("cargo", "profile fix chain formats with rustfmt"))(
  "a real cargo toolchain's formatter fixes the changed file",
  async () => {
    // Another test file in the same process may have moved HOME; the toolchain lives in the real one.
    const saved = process.env.HOME
    process.env.HOME = userInfo().homedir
    cleanup.push(() => {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
    })
    const f = fixFixture({
      writes: [{ path: "src/lib.rs", content: "pub fn   add(a:i32,b:i32)->i32{a+b}\n" }],
    })
    await confirm(f, fixProfile([{ command: "rustfmt --edition 2021", files: ["**/*.rs"] }]), [
      proof("fix:0"),
    ])
    await runPlan(f)
    await drive(f.runtime, 14)
    expect(readFileSync(join(workspaceOf(f), "src/lib.rs"), "utf8")).toBe(
      "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    )
  },
  90_000,
)

test.skipIf(
  !requireToolchain("npm-cache", "profile fix chain runs eslint --fix from the npm cache"),
)(
  "a real eslint --fix from the npm toolchain fixes the changed file",
  async () => {
    const tools = fixtureRepo("npm-eslint-vitest")
    cleanup.push(tools.cleanup)
    const install = Bun.spawnSync(
      ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: tools.root, stdout: "ignore", stderr: "pipe" },
    )
    expect(install.exitCode).toBe(0)
    const eslint = `${join(tools.root, "node_modules/.bin/eslint")} --config ${join(tools.root, "eslint.config.js")} --rule 'prefer-const: error'`
    const f = fixture({
      taskFiles: [{ name: "a", path: "src/sum.js" }],
      checkCommand: "npm run lint",
      writes: [{ path: "src/sum.js", content: "let total = 1\nexport const value = total\n" }],
    })
    await confirm(
      f,
      {
        toolchains: ["npm"],
        verify: [{ id: "lint", command: "npm run lint" }],
        fix: [{ command: `${eslint} --fix`, files: ["**/*.js"] }],
        source: { include: ["src/**/*.js"] },
      },
      [proof("fix:0")],
    )
    await runPlan(f)
    await drive(f.runtime, 14)
    expect(readFileSync(join(workspaceOf(f), "src/sum.js"), "utf8")).toBe(
      "const total = 1\nexport const value = total\n",
    )
  },
  120_000,
)
