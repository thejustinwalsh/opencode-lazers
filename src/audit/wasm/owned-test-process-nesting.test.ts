import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { OwnedTestProcessError, runOwnedTestProcess } from "./owned-test-process.ts"

const nestedProbe = fileURLToPath(new URL("./owned-nested-process-probe.ts", import.meta.url))

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(20)
  }
  return true
}

test("terminating an outer owner also kills its nested inherited-group probe", async () => {
  const controller = new AbortController()
  let forwardedOutput = ""
  let failure: unknown
  try {
    await runOwnedTestProcess([process.execPath, nestedProbe], {
      timeoutMs: 5_000,
      signal: controller.signal,
      forwardOutput: false,
      onOutput: (_stream, chunk) => {
        forwardedOutput += Buffer.from(chunk).toString()
        if (/owner:\d+/.test(forwardedOutput) && /nested:\d+/.test(forwardedOutput))
          controller.abort("terminate outer process owner")
      },
    })
  } catch (error) {
    failure = error
  }

  expect(failure).toBeInstanceOf(OwnedTestProcessError)
  expect(failure).toMatchObject({ kind: "aborted" })
  const ownerPID = Number(forwardedOutput.match(/owner:(\d+)/)?.[1])
  const nestedPID = Number(forwardedOutput.match(/nested:(\d+)/)?.[1])
  expect(ownerPID).toBeGreaterThan(0)
  expect(nestedPID).toBeGreaterThan(0)
  expect(nestedPID).not.toBe(ownerPID)
  expect(await waitForProcessExit(ownerPID, 5_000)).toBe(true)
  expect(await waitForProcessExit(nestedPID, 5_000)).toBe(true)
})
