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
