import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fakeTools, fixtureRepo, requireToolchain } from "../../test/fixtures/profile/toolchain.ts"
import { parseProfile, type ProjectProfile } from "./profile.ts"
import { proveProfile, type ProofWorkspace } from "./profile-proof.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const temp = (prefix: string) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]

/** A repository with the given files, one commit. Paths ending in `.sh` are executable. */
function repo(files: Record<string, string>) {
  const root = temp("lazers-proof-repo-")
  git(root, "init", "--initial-branch=main")
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
    if (path.endsWith(".sh")) chmodSync(join(root, path), 0o755)
  }
  git(root, "add", "-A")
  git(root, ...IDENTITY, "commit", "-m", "base")
  return root
}

/** A native-worktree stand-in: `git worktree add --detach`, non-forced remove. */
function workspace(root: string, failRemove = false): ProofWorkspace & { created: string[] } {
  const parent = `${root}.worktrees`
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }))
  const created: string[] = []
  return {
    created,
    async create({ base, name }) {
      const directory = join(parent, name)
      mkdirSync(parent, { recursive: true })
      git(root, "worktree", "add", "--detach", directory, base)
      created.push(directory)
      return directory
    },
    async remove(directory) {
      if (failRemove) throw new Error("worktree is busy")
      git(root, "worktree", "remove", directory)
    },
  }
}
const profileOf = (value: unknown): ProjectProfile => {
  const parsed = parseProfile(value)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.profile
}
const byKey = (proofs: { key: string }[]) =>
  Object.fromEntries(proofs.map((p) => [p.key, p])) as Record<string, never>

const FAKE_CARGO = `#!/bin/sh
case "$1" in
  --version) echo "cargo 9.9.9 (fake)" ;;
  fetch) exit 0 ;;
  fmt) exit 0 ;;
  test) echo ran > "$MARKER"; echo "boom" >&2; exit 3 ;;
esac
`
const FIXER = `#!/bin/sh
for f in "$@"; do echo fixed >> "$f"; done
`
const base = {
  toolchains: ["cargo"],
  verify: [
    { id: "fmt", command: "cargo fmt --check" },
    { id: "tests", command: "cargo test" },
  ],
  source: { include: ["src/**/*.rs"] },
}

test("fake toolchain: every command really runs, a failure is recorded with its exit code", async () => {
  const tools = fakeTools({ cargo: FAKE_CARGO })
  cleanups.push(tools.cleanup)
  const root = repo({ "src/lib.rs": "pub fn a() {}\n", "README.md": "hi\n", "fixer.sh": FIXER })
  const data = temp("lazers-proof-data-")
  const marker = join(data, "marker")
  const before = git(root, "status", "--porcelain")
  const ws = workspace(root)
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: data,
    profile: profileOf({
      ...base,
      fix: [{ command: "./fixer.sh", files: ["**/*.rs"] }],
    }),
    workspace: ws,
    environment: { ...process.env, PATH: `${tools.bin}:${process.env.PATH}`, MARKER: marker },
  })
  const proofs = byKey(result.proofs) as Record<string, any>
  expect(proofs["tool:cargo"]).toMatchObject({
    outcome: "proven",
    toolVersion: "cargo 9.9.9 (fake)",
  })
  expect(proofs["install:0"]).toMatchObject({
    outcome: "proven",
    command: "'cargo' 'fetch' '--locked'",
  })
  expect(proofs["verify:fmt"]).toMatchObject({ outcome: "proven", exitCode: 0 })
  expect(proofs["verify:tests"]).toMatchObject({ outcome: "failed", exitCode: 3 })
  expect(proofs["verify:tests"].stderrTail).toContain("boom")
  expect(readFileSync(marker, "utf8").trim()).toBe("ran")
  expect(proofs["fix:0"]).toMatchObject({
    outcome: "proven",
    effectiveCommand: "./fixer.sh 'src/lib.rs'",
  })
  expect(result.workspaceRemoved).toBe(true)
  expect(existsSync(ws.created[0]!)).toBe(false)
  expect(git(root, "status", "--porcelain")).toBe(before)
  expect(readFileSync(join(root, "src/lib.rs"), "utf8")).toBe("pub fn a() {}\n")
  expect(existsSync(join(data, "profile-proofs"))).toBe(true)
  expect(result.mapPreview.currentFiles).toBeGreaterThanOrEqual(0)
})

test("a fixer that touches a file it was not given fails", async () => {
  const tools = fakeTools({
    cargo: FAKE_CARGO,
    "fixall.sh": `#!/bin/sh\necho x >> README.md\nfor f in "$@"; do echo x >> "$f"; done\n`,
  })
  cleanups.push(tools.cleanup)
  const root = repo({ "src/lib.rs": "pub fn a() {}\n", "README.md": "hi\n" })
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: temp("lazers-proof-data-"),
    profile: profileOf({
      ...base,
      fix: [{ command: `${tools.bin}/fixall.sh`, files: ["**/*.rs"] }],
    }),
    workspace: workspace(root),
    environment: { ...process.env, PATH: `${tools.bin}:${process.env.PATH}`, MARKER: "/dev/null" },
  })
  expect(byKey(result.proofs)["fix:0"]).toMatchObject({
    outcome: "failed",
    reason: "changed files it was not given: README.md",
  })
})

test("after a failing fix the later entries do not run", async () => {
  const tools = fakeTools({
    cargo: FAKE_CARGO,
    "bad.sh": "#!/bin/sh\nexit 1\n",
    "second.sh": `#!/bin/sh\ntouch "$MARKER.second"\n`,
  })
  cleanups.push(tools.cleanup)
  const root = repo({ "src/lib.rs": "pub fn a() {}\n" })
  const data = temp("lazers-proof-data-")
  const marker = join(data, "marker")
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: data,
    profile: profileOf({
      ...base,
      fix: [
        { command: `${tools.bin}/bad.sh`, files: ["**/*.rs"] },
        { command: `${tools.bin}/second.sh`, files: ["**/*.rs"] },
      ],
    }),
    workspace: workspace(root),
    environment: { ...process.env, PATH: `${tools.bin}:${process.env.PATH}`, MARKER: marker },
  })
  const proofs = byKey(result.proofs) as Record<string, any>
  expect(proofs["fix:0"]).toMatchObject({ outcome: "failed", exitCode: 1 })
  expect(proofs["fix:1"]).toMatchObject({ outcome: "not-run", reason: "an earlier fix failed" })
  expect(existsSync(`${marker}.second`)).toBe(false)
})

test("a fix entry whose globs match no tracked file is not run", async () => {
  const tools = fakeTools({ cargo: FAKE_CARGO })
  cleanups.push(tools.cleanup)
  const root = repo({ "src/lib.rs": "pub fn a() {}\n" })
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: temp("lazers-proof-data-"),
    profile: profileOf({ ...base, fix: [{ command: "true", files: ["**/*.py"] }] }),
    workspace: workspace(root),
    environment: { ...process.env, PATH: `${tools.bin}:${process.env.PATH}`, MARKER: "/dev/null" },
  })
  expect(byKey(result.proofs)["fix:0"]).toMatchObject({
    outcome: "not-run",
    reason: "no tracked file matches its files globs",
  })
})

test("a toolchain that is not installed is failed, naming where it looked", async () => {
  const root = repo({ "src/lib.rs": "pub fn a() {}\n" })
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: temp("lazers-proof-data-"),
    profile: profileOf({
      toolchains: ["lz-no-such-toolchain"],
      verify: [{ id: "ok", command: "true" }],
      source: { include: ["src/**"] },
    }),
    workspace: workspace(root),
    environment: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  const tool = byKey(result.proofs)["tool:lz-no-such-toolchain"] as any
  expect(tool.outcome).toBe("failed")
  expect(tool.reason).toContain("lz-no-such-toolchain not found on the service PATH (searched:")
  expect(byKey(result.proofs)["verify:ok"]).toMatchObject({ outcome: "proven" })
})

test("a worktree that cannot be removed is reported, never thrown", async () => {
  const root = repo({ "src/lib.rs": "pub fn a() {}\n" })
  const ws = workspace(root, true)
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: temp("lazers-proof-data-"),
    profile: profileOf({
      verify: [{ id: "ok", command: "true" }],
      source: { include: ["src/**"] },
    }),
    workspace: ws,
    environment: { PATH: "/usr/bin:/bin" },
  })
  expect(result.workspaceRemoved).toBe(false)
  expect(result.workspaceReason).toBe("worktree is busy")
  expect(existsSync(ws.created[0]!)).toBe(true)
})

test("proof targets are appended to a verify command for its proof only", async () => {
  const root = repo({ "a.txt": "x\n" })
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: temp("lazers-proof-data-"),
    profile: profileOf({
      verify: [{ id: "t", command: "echo ran" }],
      source: { include: ["*.txt"] },
    }),
    proofTargets: { t: ["it's.test.ts"] },
    workspace: workspace(root),
    environment: { PATH: "/usr/bin:/bin" },
  })
  expect(byKey(result.proofs)["verify:t"]).toMatchObject({
    command: "echo ran",
    effectiveCommand: "echo ran 'it'\\''s.test.ts'",
    outcome: "proven",
  })
})

test.todo("map preview counts source files in any language once Task 5.1 has landed")

const cargoAvailable = requireToolchain("cargo", "proves the cargo-min fixture with real cargo")
test.skipIf(!cargoAvailable)("real cargo: the cargo-min profile proves every command", async () => {
  const fixture = fixtureRepo("cargo-min")
  cleanups.push(fixture.cleanup)
  const profile = profileOf({
    toolchains: ["cargo"],
    verify: [
      { id: "fmt", command: "cargo fmt --check" },
      { id: "tests", command: "cargo test --locked" },
    ],
    fix: [{ command: "cargo fmt --", files: ["**/*.rs"] }],
    env: ["CARGO_HOME", "RUSTUP_HOME"],
    audit: "off",
    source: { include: ["src/**/*.rs"] },
  })
  const run = () =>
    proveProfile({
      projectDirectory: fixture.root,
      dataDirectory: temp("lazers-proof-data-"),
      profile,
      workspace: workspace(fixture.root),
    })
  const ok = byKey((await run()).proofs) as Record<string, any>
  for (const key of ["tool:cargo", "install:0", "verify:fmt", "verify:tests", "fix:0"])
    expect(ok[key]?.outcome, key).toBe("proven")
  writeFileSync(
    join(fixture.root, "src/lib.rs"),
    readFileSync(join(fixture.root, "src/lib.rs"), "utf8").replace("2, 2), 4)", "2, 2), 5)"),
  )
  git(fixture.root, "add", "-A")
  git(fixture.root, ...IDENTITY, "commit", "-m", "break the test")
  const broken = byKey((await run()).proofs) as Record<string, any>
  expect(broken["verify:tests"]).toMatchObject({ outcome: "failed", exitCode: 101 })
})

const npmAvailable = requireToolchain(
  "npm-cache",
  "proves the npm-eslint-vitest fixture with real npm",
)
test.skipIf(!npmAvailable)(
  "real npm: the npm-eslint-vitest profile proves every command",
  async () => {
    const fixture = fixtureRepo("npm-eslint-vitest")
    cleanups.push(fixture.cleanup)
    const result = await proveProfile({
      projectDirectory: fixture.root,
      dataDirectory: temp("lazers-proof-data-"),
      profile: profileOf({
        toolchains: ["npm"],
        verify: [
          { id: "lint", command: "npm run lint" },
          { id: "tests", command: "npx --no-install vitest run" },
        ],
        fix: [{ command: "npx --no-install eslint --fix", files: ["**/*.js"] }],
        audit: "off",
        source: { include: ["src/**/*.js"] },
      }),
      workspace: workspace(fixture.root),
    })
    const proofs = byKey(result.proofs) as Record<string, any>
    for (const key of ["tool:npm", "install:0", "verify:lint", "verify:tests", "fix:0"])
      expect(proofs[key]?.outcome, key).toBe("proven")
  },
)

test("this repository's profile commands prove in a repository run under bun", async () => {
  const root = repo({
    "a.ts": "export const   a   =  1;\n",
    "b.ts": "export function b( ){return   2}\n",
    "x.test.ts": 'import {test,expect} from "bun:test"\ntest("x",()=>{expect(1).toBe(1)})\n',
  })
  const lazers = JSON.parse(
    readFileSync(join(import.meta.dir, "../../test/fixtures/profile/lazers.profile.json"), "utf8"),
  )
  const profile = profileOf({
    ...lazers,
    verify: lazers.verify.filter(
      (entry: { id: string }) => entry.id === "format" || entry.id === "tests",
    ),
  })
  const result = await proveProfile({
    projectDirectory: root,
    dataDirectory: temp("lazers-proof-data-"),
    profile,
    proofTargets: { tests: ["x.test.ts"] },
    workspace: workspace(root),
  })
  const proofs = byKey(result.proofs) as Record<string, any>
  expect(proofs["verify:format"].outcome).toBe("failed")
  expect(proofs["verify:tests"].outcome).toBe("proven")
  expect(proofs["fix:0"].outcome).toBe("proven")
}, 120_000)
