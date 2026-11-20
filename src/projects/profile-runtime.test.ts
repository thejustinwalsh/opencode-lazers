import { expect, test } from "bun:test"
import { parseProfile } from "./profile.ts"
import type { ActiveProfile, ProofRecord } from "./profile-store.ts"
import { checkRunProfile, runnableFix, runnableInstall } from "./profile-runtime.ts"

const proof = (key: string, outcome: ProofRecord["outcome"], extra: Partial<ProofRecord> = {}) =>
  [
    key,
    {
      key,
      command: "x",
      outcome,
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdoutTail: "",
      stderrTail: "",
      ranAt: 1,
      ...extra,
    },
  ] as const
function active(proofs: (readonly [string, ProofRecord])[], extra: object = {}): ActiveProfile {
  const parsed = parseProfile({
    toolchains: ["cargo"],
    verify: [{ id: "tests", command: "cargo test --locked" }],
    fix: [{ command: "cargo fmt --", files: ["**/*.rs"] }, { command: "cargo clippy --fix" }],
    env: ["RUSTUP_HOME"],
    source: { include: ["src/**/*.rs"] },
    ...extra,
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return {
    revisionID: 7,
    revision: 3,
    projectKey: "k",
    profile: parsed.profile,
    confirmedAt: 1,
    proofs: new Map(proofs),
  }
}

test("runnable fix excludes failed and not-run entries", () => {
  const profile = active([proof("fix:0", "proven"), proof("fix:1", "failed")])
  expect(runnableFix(profile)).toEqual([{ index: 0, command: "cargo fmt --", files: ["**/*.rs"] }])
  expect(runnableFix(active([proof("fix:0", "not-run"), proof("fix:1", "proven")]))).toEqual([
    { index: 1, command: "cargo clippy --fix" },
  ])
  expect(runnableFix(active([]))).toEqual([])
})

test("runnable install is the proven entries only", () => {
  const withInstall = active([proof("install:0", "proven")], { install: "make deps" })
  expect(runnableInstall(withInstall, "/w")).toEqual([{ source: "profile", command: "make deps" }])
  expect(
    runnableInstall(active([proof("install:0", "failed")], { install: "make deps" }), "/w"),
  ).toEqual([])
  const hardened = runnableInstall(active([proof("install:0", "proven")]), "/w")
  expect(hardened).toEqual([
    { source: "hardened-default", toolchain: "cargo", argv: ["cargo", "fetch", "--locked"] },
  ])
  expect(runnableInstall(active([]), "/w")).toEqual([])
})

test("the check run profile carries commands, the revision and tool versions, never env values", () => {
  const run = checkRunProfile(
    active([proof("tool:cargo", "proven", { toolVersion: "cargo 9.9.9" })]),
  )
  expect(run.revisionID).toBe(7)
  expect(run.toolchains).toEqual(["cargo"])
  expect(run.commands).toEqual({
    toolchains: ["cargo"],
    verify: ["cargo test --locked"],
    fix: ["cargo fmt --", "cargo clippy --fix"],
  })
  expect(run.identity).toEqual({
    revision: 3,
    toolchains: ["cargo"],
    env: ["RUSTUP_HOME"],
    toolVersions: { cargo: "cargo 9.9.9" },
  })
})

test("the audit is off only when a confirmed profile says so", async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { registerProject, resetProjectAliasCache } = await import("../project-key.ts")
  const { TaskRepository } = await import("../storage.ts")
  const { proposeRevision, confirmRevision } = await import("./profile-store.ts")
  const { auditIsOff } = await import("./profile-runtime.ts")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-audit-off-")))
  Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"])
  Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "git@h.com:a/off.git"])
  const repository = new TaskRepository(join(root, "db.sqlite"), root)
  try {
    const { key } = await registerProject(repository, { directory: root, opencodeProjectID: "p" })
    expect(auditIsOff(repository, root)).toBe(false)
    const parsed = parseProfile({
      verify: [{ id: "t", command: "true" }],
      audit: "off",
      source: { include: ["src/**"] },
    })
    if (!parsed.ok) throw new Error("bad fixture")
    proposeRevision(repository, {
      projectKey: key,
      profile: parsed.profile,
      author: { kind: "owner" },
      reason: "t",
      proofs: [],
    })
    expect(auditIsOff(repository, root)).toBe(false)
    confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })
    expect(auditIsOff(repository, root)).toBe(true)
  } finally {
    resetProjectAliasCache()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})
