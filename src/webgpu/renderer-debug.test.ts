import { expect, test } from "bun:test"
import { captureRendererDebug } from "./renderer-debug.ts"

class FakeDebugger {
  attached = false
  readonly calls: string[] = []
  stopResponse: unknown = {
    profile: {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "root",
            scriptId: "1",
            url: "file:///runtime.js?prompt=secret",
            lineNumber: -1,
            columnNumber: -1,
          },
          children: [2],
          hitCount: 1,
        },
        {
          id: 2,
          callFrame: {
            functionName: "generate",
            scriptId: "2",
            url: "file:///runtime.js",
            lineNumber: 10,
            columnNumber: 2,
          },
          children: [],
        },
      ],
      samples: [1, 2],
      timeDeltas: [100, 200],
      startTime: 1000,
      endTime: 1300,
    },
  }

  isAttached() {
    return this.attached
  }

  attach() {
    this.calls.push("attach")
    this.attached = true
  }

  detach() {
    this.calls.push("detach")
    this.attached = false
  }

  async sendCommand(method: string) {
    this.calls.push(method)
    if (method === "Profiler.stop") return this.stopResponse
    return {}
  }
}

const correlation = {
  windowID: 17,
  rendererPID: 4242,
  lastStage: "run",
  lastRequestID: "request-1",
  lastJobID: "job-1",
}

const options = (transport: FakeDebugger, overrides: Record<string, unknown> = {}) => ({
  renderer: { debugger: transport, isDevToolsOpened: () => false },
  correlation,
  directory: "/diagnostics",
  profileMs: 100,
  timeoutMs: 500,
  makeDirectory: async () => {},
  write: async () => {},
  ...overrides,
})

test("captures a meaningful graph profile, preserves samples, and detaches", async () => {
  const transport = new FakeDebugger()
  const writes: { path: string; data: string }[] = []
  const result = await captureRendererDebug(
    options(transport, {
      write: async (path: string, data: string) => writes.push({ path, data }),
    }),
  )

  expect(result).toMatchObject({ captured: true, lastStage: "run" })
  expect(result.path).toContain("/diagnostics/renderer-unresponsive-")
  expect(result.profilePath).toContain(".cpuprofile")
  expect(result.profile?.nodes[0]).toMatchObject({
    id: 1,
    hitCount: 1,
    children: [2],
    callFrame: {
      functionName: "root",
      scriptId: "1",
      url: "file:///runtime.js",
      lineNumber: -1,
      columnNumber: -1,
    },
  })
  expect(result.profile?.samples).toEqual([1, 2])
  expect(result.profile?.timeDeltas).toEqual([100, 200])
  expect(JSON.stringify(result)).not.toContain("secret")
  expect(transport.calls).toEqual([
    "attach",
    "Profiler.enable",
    "Profiler.start",
    "Profiler.stop",
    "detach",
  ])
  const metadata = writes.find((write) => write.path.endsWith(".json"))
  const profile = writes.find((write) => write.path.endsWith(".cpuprofile"))
  expect(metadata && JSON.parse(metadata.data)).toMatchObject({
    captured: true,
    lastJobID: "job-1",
    profilePath: result.profilePath,
  })
  expect(profile && JSON.parse(profile.data)).toMatchObject({ samples: [1, 2] })
})

test("does not take over an existing inspector or DevTools session", async () => {
  const attached = new FakeDebugger()
  attached.attached = true
  const writes: string[] = []
  const first = await captureRendererDebug(
    options(attached, { write: async (path: string) => void writes.push(path) }),
  )
  const second = await captureRendererDebug({
    ...options(new FakeDebugger()),
    renderer: { debugger: new FakeDebugger(), isDevToolsOpened: () => true },
    write: async (path: string) => void writes.push(path),
  })
  expect(first.reason).toBe("debugger-attached")
  expect(second.reason).toBe("devtools-open")
  expect(writes).toHaveLength(0)
})

test("persists profiler stop timeout as a failure and always detaches", async () => {
  const transport = new FakeDebugger()
  transport.sendCommand = async (method: string) => {
    transport.calls.push(method)
    if (method === "Profiler.stop") await new Promise(() => {})
    return {}
  }
  const writes: string[] = []
  const result = await captureRendererDebug(
    options(transport, {
      timeoutMs: 100,
      write: async (_path: string, data: string) => writes.push(data),
    }),
  )
  expect(result).toMatchObject({
    captured: false,
    reason: "timeout",
    failure: "profiler-stop",
  })
  expect(result.path).toContain("/diagnostics/renderer-unresponsive-")
  expect(JSON.parse(writes[0]!)).toMatchObject({ captured: false, failure: "profiler-stop" })
  expect(transport.calls).toEqual([
    "attach",
    "Profiler.enable",
    "Profiler.start",
    "Profiler.stop",
    "detach",
  ])
})

test("abort races the active profiler command and detaches", async () => {
  const transport = new FakeDebugger()
  transport.sendCommand = async (method: string) => {
    transport.calls.push(method)
    if (method === "Profiler.stop") await new Promise(() => {})
    return {}
  }
  const controller = new AbortController()
  const pending = captureRendererDebug(options(transport, { signal: controller.signal }))
  setTimeout(() => controller.abort(), 10)
  const result = await pending
  expect(result).toMatchObject({ captured: false, reason: "aborted", failure: "profiler-stop" })
  expect(transport.calls.at(-1)).toBe("detach")
})

test("empty profiler output is not reported as a successful capture", async () => {
  const transport = new FakeDebugger()
  transport.stopResponse = { profile: { nodes: [], samples: [], timeDeltas: [] } }
  const result = await captureRendererDebug(options(transport))
  expect(result).toMatchObject({ captured: false, reason: "profile-empty", failure: "profile" })
})

test("persists metadata when the standalone profile artifact cannot be written", async () => {
  const transport = new FakeDebugger()
  const writes: { path: string; data: string }[] = []
  const result = await captureRendererDebug(
    options(transport, {
      write: async (path: string, data: string) => {
        if (path.endsWith(".cpuprofile")) throw new Error("diagnostics unavailable")
        writes.push({ path, data })
      },
    }),
  )
  expect(result.path).toContain(".json")
  expect(result.profilePath).toBeUndefined()
  expect(result.captured).toBe(false)
  expect(result.failure).toBe("profile")
  expect(writes).toHaveLength(1)
  expect(JSON.parse(writes[0]!.data)).toMatchObject({ captured: false, failure: "profile" })
})

test("rejects dangling samples and oversized profiles instead of corrupting timing", async () => {
  const invalid = new FakeDebugger()
  const response = invalid.stopResponse as { profile: { samples: number[] } }
  response.profile.samples[1] = 999
  const invalidResult = await captureRendererDebug(options(invalid))
  expect(invalidResult).toMatchObject({ captured: false, reason: "profile-invalid" })
  const oversized = new FakeDebugger()
  const large = oversized.stopResponse as { profile: { nodes: unknown[] } }
  large.profile.nodes = Array.from({ length: 2001 }, () => ({}))
  const largeResult = await captureRendererDebug(options(oversized))
  expect(largeResult).toMatchObject({ captured: false, reason: "profile-too-large" })
})
