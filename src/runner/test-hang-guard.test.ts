import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCheck, runDeclaredCheck } from "./artifacts.ts"
import { GUARDED_TEST_COMMAND, TEST_HANG_GUARD_MS } from "./test-hang-guard.ts"

const guard = `--timeout ${TEST_HANG_GUARD_MS}`
const defaults = `${guard} --dots`
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("the package test script and the standing guidance carry the same guarded command", () => {
  const root = join(import.meta.dir, "..", "..")
  const read = (path: string) => readFileSync(join(root, path), "utf8")
  expect(JSON.parse(read("package.json")).scripts.test).toBe(GUARDED_TEST_COMMAND)
  for (const path of ["AGENTS.md", "src/implementor.md"])
    expect(read(path)).toContain(GUARDED_TEST_COMMAND)
  expect(read("src/architect.md")).toContain(guard)
  // Standing task prompts carry no repository commands; the project profile supplies them.
  expect(read("src/tasks/instructions.ts")).not.toContain("bun test")
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
  expect(receipt.effectiveCommand).toBe(`bun test ${defaults}`)
  expect(JSON.parse(readFileSync(receiptPath, "utf8")).effectiveCommand).toBe(
    `bun test ${defaults}`,
  )
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
    `bun test ${defaults} a.test.ts && bun test ${defaults} b.test.ts`,
  )
  expect(receipt.phases?.map((phase) => phase.effectiveCommand)).toEqual([
    `bun test ${defaults} a.test.ts`,
    `bun test ${defaults} b.test.ts`,
  ])
})
