import { expect, test } from "bun:test"

test("group and row render owners survive fresh models and live updates by canonical key", () => {
  // Use real client-side Solid reactivity, isolated from Bun's default server conditions
  // and other suites' GUI mocks. No DOM or listening server is needed for identity checks.
  const run = Bun.spawnSync([
    process.execPath,
    "--conditions=browser",
    "run",
    "test/task-panel/fixtures/keyed-identity.ts",
  ])
  expect(new TextDecoder().decode(run.stderr)).toBe("")
  expect(run.exitCode).toBe(0)
  expect(new TextDecoder().decode(run.stdout)).toContain("Canonical group/row identities retained")
})
