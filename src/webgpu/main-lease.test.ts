import { expect, test } from "bun:test"

test("registered GUI runtime and main preserve abort-faithful exact lease handoff", async () => {
  const process = Bun.spawn([processPath(), "run", "test/webgpu-main-lease.fixture.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(output).toContain("registered abort-faithful lease handoff passed")
}, 30_000)

test("registered main returns and tracks pending renderer generation registration", async () => {
  const process = Bun.spawn(
    [processPath(), "run", "test/webgpu-main-lease-registration.fixture.ts"],
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
  expect(output).toContain("registered main generation registration lifecycle passed")
}, 30_000)

const processPath = () => globalThis.process.execPath
