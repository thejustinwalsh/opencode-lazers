import { afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { deriveSourceDefinition } from "../../../src/context/repo-map.ts"
import { parseProfile } from "../../../src/projects/profile.ts"
import {
  fakeTools,
  fixtureRepo,
  requireToolchain,
  toolchainAvailable,
  type Availability,
} from "./toolchain.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  delete process.env.LAZERS_REQUIRE_TOOLCHAINS
})
const git = (cwd: string, args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe" }).stdout.toString().trim()
const missing = (name: string): Availability => ({ available: false, reason: `${name} is absent` })

test("a fixture copy is a clean git repository whose HEAD holds the lockfile", () => {
  for (const [name, lock] of [
    ["cargo-min", "Cargo.lock"],
    ["npm-eslint-vitest", "package-lock.json"],
  ] as const) {
    const fixture = fixtureRepo(name)
    cleanups.push(fixture.cleanup)
    expect(git(fixture.root, ["status", "--porcelain"])).toBe("")
    expect(git(fixture.root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")).toContain(lock)
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.base)
  }
})

test("a fake tool is an executable that writes its marker and exits non-zero", () => {
  const tools = fakeTools({ cargo: '#!/bin/sh\necho fake-cargo "$@" > "$MARKER"\nexit 3' })
  cleanups.push(tools.cleanup)
  const marker = join(tools.bin, "marker.txt")
  const result = Bun.spawnSync([join(tools.bin, "cargo"), "test", "--locked"], {
    env: { ...process.env, MARKER: marker },
  })
  expect(result.exitCode).toBe(3)
  expect(existsSync(marker)).toBe(true)
  expect(readFileSync(marker, "utf8").trim()).toBe("fake-cargo test --locked")
})

test("a missing toolchain warns loudly and reports unavailable", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    expect(requireToolchain("cargo", "builds the fixture", missing)).toBe(false)
    expect(warn).toHaveBeenCalledWith("SKIPPED (cargo is absent): builds the fixture")
  } finally {
    warn.mockRestore()
  }
})

test("under LAZERS_REQUIRE_TOOLCHAINS=1 a missing toolchain throws", () => {
  process.env.LAZERS_REQUIRE_TOOLCHAINS = "1"
  expect(() => requireToolchain("cargo", "builds the fixture", missing)).toThrow(
    "Toolchain cargo is required by LAZERS_REQUIRE_TOOLCHAINS",
  )
  expect(requireToolchain("cargo", "t", () => ({ available: true, reason: "" }))).toBe(true)
})

test("availability reports a reason for every name", () => {
  for (const name of ["cargo", "npm", "npm-cache"] as const) {
    const result = toolchainAvailable(name)
    expect(typeof result.available).toBe("boolean")
    if (!result.available) expect(result.reason.length).toBeGreaterThan(0)
  }
})

test("this repository's profile parses and its exclude is what derivation returns", async () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "lazers.profile.json"), "utf8"))
  const parsed = parseProfile(raw)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  const root = join(import.meta.dir, "..", "..", "..")
  expect(parsed.profile.source.exclude).toEqual((await deriveSourceDefinition(root)).exclude)
  expect(parsed.profile.toolchains).toEqual(["bun"])
})
