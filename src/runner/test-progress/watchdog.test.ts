import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkResourcesSettled, runCheck } from "../artifacts.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("real multi-file Bun dots reset inactivity while a genuinely silent child times out and settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-bun-test-progress-"))
  roots.push(root)
  for (const name of ["first", "second", "third"])
    writeFileSync(
      join(root, `${name}.test.ts`),
      `import { test } from "bun:test"\ntest("${name}", async () => { await Bun.sleep(1_400) })\n`,
    )

  const command = "bun test --parallel=1 first.test.ts second.test.ts third.test.ts"
  const progress = await runCheck(
    root,
    "candidate",
    {
      id: "multi-file-progress",
      command,
      inactivityTimeoutMs: 3_500,
      hardTimeoutMs: 15_000,
    },
    join(root, "progress.json"),
  )

  expect(progress.command).toBe(command)
  expect(progress.effectiveCommand).toBe(
    "bun test --timeout 120000 --dots --parallel=1 first.test.ts second.test.ts third.test.ts",
  )
  expect(progress.exitCode).toBe(0)
  expect(progress.timedOut).toBe(false)
  expect(
    `${progress.stdout}\n${progress.stderr}`.split(/\r?\n/).some((line) => /^[.·]{3,}$/.test(line)),
  ).toBe(true)
  expect(progress.endedAt - progress.startedAt).toBeGreaterThan(3_500)
  expect(checkResourcesSettled(progress)).toBe(true)

  const silent = await runCheck(
    root,
    "candidate",
    {
      id: "silent-child",
      command: "sleep 30",
      inactivityTimeoutMs: 150,
      hardTimeoutMs: 2_000,
    },
    join(root, "silent.json"),
  )
  expect(silent.stopCause).toBe("inactivity")
  expect(silent.timedOut).toBe(true)
  expect(checkResourcesSettled(silent)).toBe(true)
}, 30_000)
