import { expect, test } from "bun:test"

test("Never idle policy keeps the model resident across generations, loss and recovery", async () => {
  const process = Bun.spawn(
    [globalThis.process.execPath, "run", "src/webgpu/runtime-keep-resident.fixture.ts"],
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
  expect(output).toContain("Keep-resident checks passed")
}, 30_000)
