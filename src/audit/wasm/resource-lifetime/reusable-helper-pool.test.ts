import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("repeated production analyses reuse a retained helper pool", async () => {
  const script = fileURLToPath(new URL("./reusable-helper-pool-probe.ts", import.meta.url))
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  expect(code, stderr).toBe(0)
  const result = JSON.parse(stdout.trim()) as {
    runs: number
    createdWhileRetained: number
    reusedWhileRetained: number
    liveWhileRetained: number
    idleWhileRetained: number
    peakLiveCount: number
    distinctReports: number
  }
  expect(result).toEqual({
    runs: 8,
    createdWhileRetained: 2,
    reusedWhileRetained: 14,
    liveWhileRetained: 2,
    idleWhileRetained: 2,
    peakLiveCount: 2,
    distinctReports: 1,
  })
}, 120_000)
