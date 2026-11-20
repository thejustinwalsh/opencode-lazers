import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effectiveInstall, toolchainFacts } from "./toolchains.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function workspace(...files: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-toolchains-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  for (const file of files) writeFileSync(join(directory, file), "")
  return directory
}

test("bun's argv is today's, with a frozen lockfile only when one exists", () => {
  const bun = toolchainFacts("bun")
  expect(bun.hardenedInstall(workspace("bun.lock"))).toEqual([
    "bun",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--no-save",
    "--no-progress",
  ])
  expect(bun.hardenedInstall(workspace("bun.lockb"))).toContain("--frozen-lockfile")
  expect(bun.hardenedInstall(workspace())).toEqual([
    "bun",
    "install",
    "--ignore-scripts",
    "--no-save",
    "--no-progress",
  ])
})

test("npm installs from the lockfile when there is one", () => {
  const npm = toolchainFacts("npm")
  expect(npm.hardenedInstall(workspace("package-lock.json"))).toEqual([
    "npm",
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ])
  expect(npm.hardenedInstall(workspace())).toEqual([
    "npm",
    "install",
    "--ignore-scripts",
    "--no-save",
    "--no-audit",
    "--no-fund",
  ])
})

test("pnpm, yarn and cargo have lockfile-honouring installs that skip lifecycle scripts", () => {
  expect(toolchainFacts("pnpm").hardenedInstall(workspace())).toEqual([
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ])
  expect(toolchainFacts("yarn").hardenedInstall(workspace(".yarnrc.yml"))).toEqual([
    "yarn",
    "install",
    "--immutable",
    "--mode=skip-build",
  ])
  expect(toolchainFacts("yarn").hardenedInstall(workspace())).toEqual([
    "yarn",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ])
  expect(toolchainFacts("cargo").hardenedInstall(workspace("Cargo.lock"))).toEqual([
    "cargo",
    "fetch",
    "--locked",
  ])
  expect(toolchainFacts("pnpm").lockfiles).toEqual(["pnpm-lock.yaml"])
  expect(toolchainFacts("cargo").dependencies).toBe("toolchain-home")
  expect(toolchainFacts("npm").dependencies).toBe("node_modules")
})

test("an unknown toolchain runs as itself with no install", () => {
  const zig = toolchainFacts("zig")
  expect(zig.executable).toBe("zig")
  expect(zig.hardenedInstall(workspace())).toBeUndefined()
  expect(zig.dependencies).toBe("none")
  expect(zig.homes({ HOME: "/h" }, "/x/node")).toEqual([])
  expect(zig.lockfiles).toEqual([])
})

test("effective install: per-toolchain defaults in order, or the profile's command, or none", () => {
  const dir = workspace("package-lock.json")
  const both = effectiveInstall({ toolchains: ["npm", "cargo"] }, dir)
  expect(both.map((entry) => entry.source === "hardened-default" && entry.toolchain)).toEqual([
    "npm",
    "cargo",
  ])
  expect(effectiveInstall({ toolchains: ["npm", "cargo"], install: "make deps" }, dir)).toEqual([
    { source: "profile", command: "make deps" },
  ])
  expect(effectiveInstall({ toolchains: [] }, dir)).toEqual([{ source: "none" }])
  expect(effectiveInstall({ toolchains: ["zig"] }, dir)).toEqual([{ source: "none" }])
})

test("homes come from the env passed in, in order, absolute only", () => {
  const cargo = toolchainFacts("cargo")
  expect(cargo.homes({ CARGO_HOME: "/c", HOME: "/h" }, "/x/node")).toEqual([
    "/c/bin",
    "/h/.cargo/bin",
  ])
  expect(cargo.homes({ CARGO_HOME: "rel", HOME: "/h" }, "/x/node")).toEqual(["/h/.cargo/bin"])
  expect(toolchainFacts("bun").homes({ BUN_INSTALL: "/b", HOME: "/h" }, "/opt/bun")).toEqual([
    "/b/bin",
    "/h/.bun/bin",
    "/opt",
  ])
  expect(toolchainFacts("bun").homes({ HOME: "/h" }, "/usr/bin/node")).toEqual(["/h/.bun/bin"])
  expect(toolchainFacts("pnpm").homes({ HOME: "/h", PNPM_HOME: "/p" }, "/x")).toEqual([
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/h/.volta/bin",
    "/h/.local/bin",
    "/p",
    "/h/Library/pnpm",
    "/h/.local/share/pnpm",
  ])
  expect(toolchainFacts("cargo").envDefaults.CARGO_HOME!("/h")).toBe("/h/.cargo")
  expect(toolchainFacts("cargo").envDefaults.RUSTUP_HOME!("/h")).toBe("/h/.rustup")
})
