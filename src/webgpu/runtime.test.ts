import { expect, test } from "bun:test"

test("actual renderer lifecycle survives repeated loss, concurrent unload and failed disposal", async () => {
  const process = Bun.spawn([processPath(), "run", "test/webgpu-runtime.fixture.ts"], {
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
  expect(output).toContain("fault injection passed")
}, 20_000)

const processPath = () => globalThis.process.execPath
