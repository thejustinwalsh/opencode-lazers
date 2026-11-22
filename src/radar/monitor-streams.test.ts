import { expect, test } from "bun:test"

// The scenario runs in its own process (`monitor-streams.fixture.ts`): it replaces "solid-js" with
// the browser build, which must not leak into other test files.
test("a running worker whose session row arrives after its assignment is one row", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/radar/monitor-streams.fixture.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(output).toContain("one worker row")
}, 60_000)
