import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkEnvironment,
  checkFailureReason,
  checkSucceeded,
  isConclusiveNonTimeoutInterruption,
} from "./checks.ts"
import { git, runCheck, verificationEnvironmentIdentity } from "./artifacts.ts"
import { delimiter } from "node:path"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-result-"))
  roots.push(root)
  return root
}

test("a Desktop PATH without Bun discovers the installed user executable without inheriting other variables", () => {
  const home = fixture()
  const bin = join(home, ".bun", "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 0\n")
  chmodSync(join(bin, "bun"), 0o700)
  const result = checkEnvironment({ HOME: home, PATH: "/usr/bin:/bin" })
  expect(Bun.which("bun", { PATH: result.PATH })).toBe(join(bin, "bun"))
  expect(Object.keys(result).sort()).toEqual(["HOME", "PATH"])
})

test("successful commands remain successful with legacy dirty-tree and environment diagnostics", () => {
  const receipt = {
    exitCode: 0,
    timedOut: false,
    unchanged: false,
    environmentIdentity: "old environment",
  }
  expect(checkSucceeded(receipt)).toBe(true)
  expect(checkSucceeded({ ...receipt, exitCode: 1 })).toBe(false)
  expect(checkSucceeded({ ...receipt, timedOut: true })).toBe(false)
  expect(checkSucceeded({ ...receipt, aborted: true })).toBe(false)
})

test("only a conclusively settled non-timeout interrupted receipt is eligible for explicit continuation", () => {
  const interrupted = {
    id: "combined",
    command: "bun test",
    cwd: "/candidate",
    artifact: "a".repeat(40),
    inputIdentity: "a".repeat(40),
    environmentIdentity: "environment",
    startedAt: 1,
    endedAt: 2,
    exitCode: 137,
    timedOut: false,
    aborted: true,
    stopCause: "cancelled" as const,
    phasesComplete: false,
    processCleanup: {
      state: "terminated" as const,
      capability: "process-group" as const,
      rootPID: 123,
    },
    phases: [
      {
        command: "bun test",
        exitCode: 137,
        timedOut: false,
        stopCause: "cancelled" as const,
        aborted: true,
        stdout: "",
        stderr: "",
        environmentIdentity: "environment",
        processCleanup: {
          state: "terminated" as const,
          capability: "process-group" as const,
          rootPID: 123,
        },
      },
    ],
    stdout: "",
    stderr: "",
  }
  expect(isConclusiveNonTimeoutInterruption(interrupted)).toBe(true)
  expect(checkSucceeded(interrupted)).toBe(false)
  expect(isConclusiveNonTimeoutInterruption({ ...interrupted, timedOut: true })).toBe(false)
  expect(isConclusiveNonTimeoutInterruption({ ...interrupted, aborted: false })).toBe(false)
  expect(isConclusiveNonTimeoutInterruption({ ...interrupted, phasesComplete: true })).toBe(false)
  expect(isConclusiveNonTimeoutInterruption({ ...interrupted, phases: [] })).toBe(false)
  expect(
    isConclusiveNonTimeoutInterruption({
      ...interrupted,
      phases: undefined,
    }),
  ).toBe(false)
  expect(
    isConclusiveNonTimeoutInterruption({
      ...interrupted,
      phases: interrupted.phases.map((phase) => ({ ...phase, aborted: false, exitCode: 1 })),
    }),
  ).toBe(false)
  expect(
    isConclusiveNonTimeoutInterruption({
      ...interrupted,
      phases: [
        {
          ...interrupted.phases[0]!,
          aborted: false,
          stopCause: null,
          exitCode: 1,
        },
        ...interrupted.phases,
      ],
    }),
  ).toBe(false)
  expect(
    isConclusiveNonTimeoutInterruption({
      ...interrupted,
      processCleanup: {
        state: "uncertain",
        capability: "process-group",
        rootPID: 123,
      },
    }),
  ).toBe(false)
  expect(
    isConclusiveNonTimeoutInterruption({
      ...interrupted,
      processCleanup: {
        state: "terminated",
        capability: "direct-child",
        rootPID: 123,
      },
    }),
  ).toBe(false)
  expect(
    isConclusiveNonTimeoutInterruption({
      ...interrupted,
      processCleanup: { state: "terminated", capability: "process-group" },
    }),
  ).toBe(false)
})

test("auto-fixing a tracked file produces a real successful receipt without a cleanliness gate", async () => {
  const root = fixture()
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "source.txt"), "before\n")
  git(root, ["add", "source.txt"])
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "before",
  ])
  const artifact = git(root, ["rev-parse", "HEAD"])
  const receipt = await runCheck(
    root,
    artifact,
    { id: "quality", command: "printf 'after\\n' > source.txt", timeoutMs: 1000 },
    join(root, ".cache", "receipt.json"),
  )
  expect(checkSucceeded(receipt)).toBe(true)
  expect(receipt).not.toHaveProperty("unchanged")
  expect(git(root, ["diff", "--name-only"])).toBe("source.txt")
  const failed = await runCheck(
    root,
    artifact,
    { id: "quality", command: "exit 127", timeoutMs: 1000 },
    join(root, ".cache", "failed.json"),
  )
  expect(checkFailureReason(failed)).toContain("could not start")
  expect(checkFailureReason(failed)).not.toContain("changed its inputs")
})

test("isolated HOME can use the actual Bun runtime executable without guessing a host CLI", () => {
  const result = checkEnvironment({ HOME: fixture(), PATH: "/usr/bin:/bin" })
  expect(Bun.which("bun", { PATH: result.PATH })).toBe(process.execPath)
})

function fakeExecutable(directory: string, name: string) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), "#!/bin/sh\nexit 0\n")
  chmodSync(join(directory, name), 0o700)
}

test("with a profile, a toolchain outside PATH is found in its known home", () => {
  const home = fixture()
  fakeExecutable(join(home, ".cargo", "bin"), "cargo")
  const result = checkEnvironment({ PATH: "/usr/bin:/bin", HOME: home }, ["cargo"])
  expect(result.PATH).toBe(`${join(home, ".cargo", "bin")}${delimiter}/usr/bin:/bin`)
})

test("CARGO_HOME wins over the default home", () => {
  const home = fixture()
  const cargoHome = fixture()
  fakeExecutable(join(home, ".cargo", "bin"), "cargo")
  fakeExecutable(join(cargoHome, "bin"), "cargo")
  const result = checkEnvironment({ PATH: "/usr/bin", HOME: home, CARGO_HOME: cargoHome }, [
    "cargo",
  ])
  expect(result.PATH!.startsWith(join(cargoHome, "bin"))).toBe(true)
})

test("a toolchain already on PATH leaves PATH alone, and an unfound one adds nothing", () => {
  const home = fixture()
  const onPath = join(home, "path-bin")
  fakeExecutable(onPath, "cargo")
  expect(checkEnvironment({ PATH: onPath, HOME: home }, ["cargo"]).PATH).toBe(onPath)
  expect(checkEnvironment({ PATH: "/usr/bin:/bin", HOME: home }, ["zig"]).PATH).toBe(
    "/usr/bin:/bin",
  )
})

test("with a profile, Bun is not added implicitly", () => {
  const home = fixture()
  fakeExecutable(join(home, ".cargo", "bin"), "cargo")
  fakeExecutable(join(home, "bunhome", "bin"), "bun")
  const result = checkEnvironment(
    { PATH: "/usr/bin:/bin", HOME: home, BUN_INSTALL: join(home, "bunhome") },
    ["cargo"],
  )
  expect(result.PATH).not.toContain("bunhome")
})

test("the environment identity without a profile is the string it always was", () => {
  const keys = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "CI"] as const
  const environment = Object.fromEntries(
    keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  )
  const parsed = JSON.parse(verificationEnvironmentIdentity())
  expect(Object.keys(parsed).sort()).toEqual(
    ["architecture", "bunRevision", "bunVersion", "environment", "executable", "platform"].sort(),
  )
  expect(parsed.environment).toEqual(environment)
})

test("the identity with a profile adds its revision and env names", () => {
  const identity = {
    revision: 3,
    toolchains: ["cargo"],
    env: ["RUSTUP_HOME"],
    toolVersions: { cargo: "cargo 9.9.9" },
  }
  const parsed = JSON.parse(verificationEnvironmentIdentity(identity))
  expect(parsed.profile.revision).toBe(3)
  expect(parsed.profile.env).toEqual(["RUSTUP_HOME"])
  expect(verificationEnvironmentIdentity()).not.toBe(verificationEnvironmentIdentity(identity))
})
