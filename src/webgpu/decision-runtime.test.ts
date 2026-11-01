import { expect, test } from "bun:test"

test("actual decision adapter preserves cleanup ownership through failed and cancelled loads", async () => {
  const process = Bun.spawn([processPath(), "run", "test/decision-runtime.fixture.ts"], {
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
  expect(output).toContain("decision cleanup fault injection passed")
}, 20_000)

test("actual decision adapter and renderer retire only positively identified lost sessions", async () => {
  const process = Bun.spawn([processPath(), "run", "test/decision-recovery.fixture.ts"], {
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
  expect(output).toContain("decision loss retirement and pending recovery checks passed")
}, 30_000)

const processPath = () => globalThis.process.execPath
