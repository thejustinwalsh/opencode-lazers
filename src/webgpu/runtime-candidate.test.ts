import { expect, test } from "bun:test"

test("candidate completion contract, source identity, and reactive recovery paths", async () => {
  const process = Bun.spawn(
    [globalThis.process.execPath, "run", "src/webgpu/runtime-candidate.fixture.ts"],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(output).toContain("Candidate completion, identity, and reactive recovery checks passed")
}, 30_000)
