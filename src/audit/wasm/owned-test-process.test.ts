import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  OwnedTestProcessError,
  runOwnedTestProcess,
  type OwnedTestProcessChild,
  type OwnedTestProcessSpawnOptions,
  type OwnedTestProcessSpawner,
} from "./owned-test-process.ts"

const probe = fileURLToPath(new URL("./owned-process-probe.ts", import.meta.url))
const command = (scenario: string) => [process.execPath, probe, scenario]

test("forwards live output, drains successful streams and clears the deadline", async () => {
  const output: Array<{ stream: "stdout" | "stderr"; text: string }> = []
  const controller = new AbortController()
  let childExited = false
  let forwardedBeforeExit = false
  let addedListeners = 0
  let removedListeners = 0
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "addEventListener")
        return (...args: Parameters<AbortSignal["addEventListener"]>) => {
          addedListeners++
          return target.addEventListener(...args)
        }
      if (property === "removeEventListener")
        return (...args: Parameters<AbortSignal["removeEventListener"]>) => {
          removedListeners++
          return target.removeEventListener(...args)
        }
      return Reflect.get(target, property, target)
    },
  })
  const startedAt = performance.now()
  const result = await runOwnedTestProcess(command("success"), {
    timeoutMs: 2_000,
    signal,
    spawn: (cmd, options) => {
      const child = Bun.spawn(cmd, options)
      void child.exited.then(() => {
        childExited = true
      })
      return interceptedChild(child, {})
    },
    onOutput: (stream, chunk) => {
      const text = Buffer.from(chunk).toString()
      if (text.includes("progress: started")) forwardedBeforeExit = !childExited
      output.push({ stream, text })
    },
  })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("progress: started")
  expect(result.stdout).toContain("progress: finished")
  expect(result.stderr).toContain("diagnostic: started")
  expect(output.some(({ text }) => text.includes("progress: started"))).toBe(true)
  expect(forwardedBeforeExit).toBe(true)
  expect(addedListeners).toBe(1)
  expect(removedListeners).toBe(1)
  expect(performance.now() - startedAt).toBeLessThan(1_500)
})

test("retains nonzero diagnostics and bounds captured output", async () => {
  const result = await runOwnedTestProcess(command("nonzero"), {
    timeoutMs: 2_000,
    forwardOutput: false,
  })

  expect(result.exitCode).toBe(17)
  expect(result.stdout).toContain("stdout diagnostic")
  expect(result.stderr).toContain("stderr diagnostic")

  const large = await runOwnedTestProcess(command("large"), {
    timeoutMs: 2_000,
    forwardOutput: false,
  })
  expect(large.exitCode).toBe(0)
  expect(large.stdout).toContain("[... ")
  expect(large.stderr).toContain("[... ")
  expect(large.stdout.length).toBeLessThan(140_000)
  expect(large.stderr.length).toBeLessThan(140_000)
})

test("timeout terminates the owned descendant tree and drains output", async () => {
  let failure: unknown
  try {
    await runOwnedTestProcess(command("descendant"), {
      timeoutMs: 150,
      forwardOutput: false,
    })
  } catch (error) {
    failure = error
  }

  expect(failure).toBeInstanceOf(OwnedTestProcessError)
  expect(failure).toMatchObject({ kind: "timeout" })
  expect((failure as OwnedTestProcessError).stdout).toMatch(/descendant:\d+/)
})

test("abort interruption terminates the child tree", async () => {
  const controller = new AbortController()
  const interruption = setTimeout(() => controller.abort("test interruption"), 100)
  let failure: unknown
  try {
    await runOwnedTestProcess(command("descendant"), {
      timeoutMs: 2_000,
      signal: controller.signal,
      forwardOutput: false,
    })
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(interruption)
  }

  expect(failure).toBeInstanceOf(OwnedTestProcessError)
  expect(failure).toMatchObject({ kind: "aborted" })
  expect((failure as OwnedTestProcessError).stdout).toMatch(/descendant:\d+/)
})

test("an exited child with a lingering descendant is terminated before failure returns", async () => {
  let failure: unknown
  try {
    await runOwnedTestProcess(command("orphan"), {
      timeoutMs: 2_000,
      forwardOutput: false,
    })
  } catch (error) {
    failure = error
  }

  expect(failure).toBeInstanceOf(OwnedTestProcessError)
  expect((failure as OwnedTestProcessError).kind).toBe("descendants")
  expect((failure as OwnedTestProcessError).message).toContain("descendants remained")
})

function interceptedChild(
  child: ReturnType<typeof Bun.spawn>,
  overrides: Partial<OwnedTestProcessChild>,
): OwnedTestProcessChild {
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream))
    throw new Error("owned process probe was not spawned with piped output")
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: child.kill.bind(child),
    ...overrides,
  }
}

function spawnWithFailingStdout(): OwnedTestProcessSpawner {
  return (cmd: string[], options: OwnedTestProcessSpawnOptions) => {
    const child = Bun.spawn(cmd, options)
    return interceptedChild(child, {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("simulated stdout read failure"))
        },
      }),
    })
  }
}

function spawnWithRejectedExit(): OwnedTestProcessSpawner {
  return (cmd: string[], options: OwnedTestProcessSpawnOptions) => {
    const child = Bun.spawn(cmd, options)
    void child.exited.catch(() => {})
    return interceptedChild(child, {
      exited: Promise.reject(new Error("simulated exit observation failure")),
    })
  }
}

for (const [label, spawn] of [
  ["stdout stream", spawnWithFailingStdout()],
  ["exit observation", spawnWithRejectedExit()],
] as const) {
  test(`a rejected ${label} observation terminates the child`, async () => {
    let failure: unknown
    try {
      await runOwnedTestProcess(command("hang"), {
        timeoutMs: 2_000,
        forwardOutput: false,
        spawn,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(OwnedTestProcessError)
    expect((failure as OwnedTestProcessError).kind).toBe("observation")
    expect((failure as Error).message).toContain(
      label === "stdout stream"
        ? "simulated stdout read failure"
        : "simulated exit observation failure",
    )
  })
}
