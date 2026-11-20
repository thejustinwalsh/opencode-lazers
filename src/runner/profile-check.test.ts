import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkRunProfile } from "../projects/profile-runtime.ts"
import { parseProfile } from "../projects/profile.ts"
import { runDeclaredCheck } from "./artifacts.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const profile = (() => {
  const parsed = parseProfile({
    toolchains: ["cargo"],
    verify: [
      { id: "fmt", command: "cargo fmt --check" },
      { id: "tests", command: "cargo test --locked" },
    ],
    env: ["RUSTUP_HOME"],
    source: { include: ["src/**/*.rs"] },
  })
  if (!parsed.ok) throw new Error("bad fixture")
  return checkRunProfile({
    revisionID: 9,
    revision: 1,
    projectKey: "k",
    profile: parsed.profile,
    confirmedAt: 1,
    proofs: new Map(),
  })
})()

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lazers-profile-check-"))
  // The fake cargo lives in HOME/.cargo/bin, which is not on PATH.
  const home = join(root, "home")
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(home, ".cargo", "bin")
  Bun.spawnSync(["mkdir", "-p", bin])
  Bun.write(join(bin, "cargo"), '#!/bin/sh\necho "cargo $*" >> "$MARKER"\nexit 0\n')
  Bun.spawnSync(["chmod", "+x", join(bin, "cargo")])
  return { root, home, marker: join(root, "marker") }
}

test("with a profile, a chain of its commands runs as phases with the toolchain found in its home", async () => {
  const f = setup()
  const environment = { PATH: "/usr/bin:/bin", HOME: f.home, MARKER: f.marker }
  const receipt = await runDeclaredCheck(
    f.root,
    "candidate",
    { id: "both", command: "cargo fmt --check && cargo test --locked" },
    join(f.root, "receipt.json"),
    { environment, profile },
  )
  expect(receipt.exitCode).toBe(0)
  expect(receipt.phases?.map((phase) => phase.command)).toEqual([
    "cargo fmt --check",
    "cargo test --locked",
  ])
  expect(await Bun.file(f.marker).text()).toBe("cargo fmt --check\ncargo test --locked\n")
  expect(JSON.parse(receipt.environmentIdentity).profile).toMatchObject({
    revision: 1,
    env: ["RUSTUP_HOME"],
  })
})

test("with no profile the same chain is one unrecognised command", async () => {
  const f = setup()
  const receipt = await runDeclaredCheck(
    f.root,
    "candidate",
    { id: "both", command: "cargo fmt --check && cargo test --locked" },
    join(f.root, "receipt.json"),
    { environment: { PATH: "/usr/bin:/bin", HOME: f.home, MARKER: f.marker } },
  )
  expect(receipt.phases).toBeUndefined()
  expect(receipt.exitCode).not.toBe(0)
  expect(JSON.parse(receipt.environmentIdentity).profile).toBeUndefined()
})
