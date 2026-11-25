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
    peakRssMb: number
    retainedInstances: number
    retainedMemories: number
    distinctReports: number
  }
  expect(result.runs).toBe(5)
  expect(result.createdWhileRetained).toBe(2)
  expect(result.reusedWhileRetained).toBe(8)
  expect(result.liveWhileRetained).toBe(2)
  expect(result.idleWhileRetained).toBe(2)
  expect(result.peakLiveCount).toBe(2)
  expect(result.peakRssMb).toBeLessThan(1200)
  expect(result.retainedInstances).toBe(0)
  expect(result.retainedMemories).toBe(0)
  expect(result.distinctReports).toBe(1)
}, 240_000)
