import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCheck, runDeclaredCheck } from "./artifacts.ts"
import { GUARDED_TEST_COMMAND, TEST_HANG_GUARD_MS, withTestHangGuard } from "./test-hang-guard.ts"

const guard = `--timeout ${TEST_HANG_GUARD_MS}`
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("a bare bun test gains the guard right after the subcommand", () => {
  expect(withTestHangGuard("bun test")).toBe(`bun test ${guard}`)
  expect(withTestHangGuard("bun test src/a.test.ts src/b.test.ts")).toBe(
    `bun test ${guard} src/a.test.ts src/b.test.ts`,
  )
})

test("an explicit author timeout is never changed", () => {
  for (const command of [
    "bun test --timeout 30000 src/a.test.ts",
    "bun test src/a.test.ts --timeout=30000",
    "bun run verify && bun test --timeout 9000 a",
  ])
    expect(withTestHangGuard(command)).toBe(command)
})

test("bun test inside chains is guarded per segment", () => {
  expect(withTestHangGuard("bun run verify && bun test a b")).toBe(
    `bun run verify && bun test ${guard} a b`,
  )
  expect(withTestHangGuard("bun test a && bun test --timeout 5 b ; bun test c")).toBe(
    `bun test ${guard} a && bun test --timeout 5 b ; bun test ${guard} c`,
  )
  expect(withTestHangGuard("bun fmt || bun test a | tee out.txt")).toBe(
    `bun fmt || bun test ${guard} a | tee out.txt`,
  )
})

test("commands that are not bun test are untouched", () => {
  for (const command of [
    "bun run verify",
    "bun run test src/a.test.ts",
    "bun fmt && bun lint --fix",
    "pytest -x",
    "npm test",
    "bun testing",
    "echo bun test",
    "git diff --check",
  ])
    expect(withTestHangGuard(command)).toBe(command)
})

test("the package test script and the guidance carry the same guarded command", () => {
  const root = join(import.meta.dir, "..", "..")
  const read = (path: string) => readFileSync(join(root, path), "utf8")
  expect(JSON.parse(read("package.json")).scripts.test).toBe(GUARDED_TEST_COMMAND)
  for (const path of ["AGENTS.md", "src/implementor.md", "src/tasks/instructions.ts"])
    expect(read(path)).toContain(GUARDED_TEST_COMMAND)
  expect(read("src/architect.md")).toContain(guard)
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-hang-guard-"))
  roots.push(root)
  // Two files, each one test just over Bun's 5 s default, so a run without the guard fails
  // in every file. They exercise the multi-file case a first-file-only mechanism misses.
  for (const name of ["a", "b"])
    writeFileSync(
      join(root, `${name}.test.ts`),
      `import { test } from "bun:test"\ntest("${name}", async () => { await Bun.sleep(5_300) })\n`,
    )
  return root
}

test("a multi-file run slower than Bun's 5 s default passes and records both commands", async () => {
  const root = fixture()
  const receiptPath = join(root, "receipt.json")
  const receipt = await runCheck(
    root,
    "artifact",
    { id: "tests", command: "bun test" },
    receiptPath,
  )
  expect(receipt.exitCode).toBe(0)
  expect(receipt.stderr).not.toContain("timed out")
  expect(receipt.command).toBe("bun test")
  expect(receipt.effectiveCommand).toBe(`bun test ${guard}`)
  expect(JSON.parse(readFileSync(receiptPath, "utf8")).effectiveCommand).toBe(`bun test ${guard}`)
})

test("the guard also applies inside a recognised phase chain", async () => {
  const root = fixture()
  const receipt = await runDeclaredCheck(
    root,
    "artifact",
    { id: "tests", command: "bun test a.test.ts && bun test b.test.ts" },
    join(root, "receipt.json"),
  )
  expect(receipt.exitCode).toBe(0)
  expect(receipt.command).toBe("bun test a.test.ts && bun test b.test.ts")
  expect(receipt.effectiveCommand).toBe(
    `bun test ${guard} a.test.ts && bun test ${guard} b.test.ts`,
  )
  expect(receipt.phases?.map((phase) => phase.effectiveCommand)).toEqual([
    `bun test ${guard} a.test.ts`,
    `bun test ${guard} b.test.ts`,
  ])
})
