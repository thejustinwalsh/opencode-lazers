import { expect, test } from "bun:test"
import {
  createWindowsProcessOwnership,
  hasWindowsProcessDescendants,
  terminateWindowsProcessTree,
  type WindowsProcessIdentity,
  type WindowsProcessRecord,
  type WindowsProcessTermination,
  type WindowsProcessTreeOperations,
  type WindowsProcessOwnership,
} from "./owned-test-process-windows.ts"

const root: WindowsProcessIdentity = { pid: 100, startedAt: 1_000 }

function ownership(exitedAt: number): WindowsProcessOwnership {
  return { pid: root.pid, identity: Promise.resolve(root), exitedAt }
}

function treeOperations(
  initial: WindowsProcessRecord[],
  terminate: (identity: WindowsProcessIdentity) => Promise<WindowsProcessTermination>,
  next?: () => WindowsProcessRecord[],
): WindowsProcessTreeOperations {
  let calls = 0
  return {
    async listProcesses() {
      calls++
      return calls === 1 || !next ? initial : next()
    },
    terminateProcess: terminate,
  }
}

test("terminates an owned Windows descendant after its root has exited", async () => {
  const survivor: WindowsProcessRecord = {
    pid: 200,
    parentPid: root.pid,
    startedAt: 1_100,
  }
  const unrelated: WindowsProcessRecord = {
    pid: 300,
    parentPid: root.pid,
    startedAt: 1_301,
  }
  const terminated: WindowsProcessIdentity[] = []
  let remaining = [survivor, unrelated]
  const operations: WindowsProcessTreeOperations = {
    async listProcesses() {
      return remaining
    },
    async terminateProcess(identity) {
      const process = remaining.find((entry) => entry.pid === identity.pid)
      if (!process) return "already-exited"
      if (process.startedAt !== identity.startedAt) return "identity-mismatch"
      terminated.push(identity)
      remaining = remaining.filter((entry) => entry.pid !== identity.pid)
      return "terminated"
    },
  }

  await terminateWindowsProcessTree(ownership(1_300), operations)

  expect(terminated).toEqual([{ pid: survivor.pid, startedAt: survivor.startedAt }])
  expect(remaining).toEqual([unrelated])
})

test("terminates a nested Windows survivor tree deepest-first after its root exits", async () => {
  const child: WindowsProcessRecord = {
    pid: 200,
    parentPid: root.pid,
    startedAt: 1_100,
  }
  const grandchild: WindowsProcessRecord = {
    pid: 300,
    parentPid: child.pid,
    startedAt: 1_200,
  }
  let remaining = [grandchild, child]
  const terminated: WindowsProcessIdentity[] = []
  const operations: WindowsProcessTreeOperations = {
    async listProcesses() {
      return remaining
    },
    async terminateProcess(identity) {
      const process = remaining.find((entry) => entry.pid === identity.pid)
      if (!process) return "already-exited"
      if (process.startedAt !== identity.startedAt) return "identity-mismatch"
      terminated.push(identity)
      remaining = remaining.filter((entry) => entry.pid !== identity.pid)
      return "terminated"
    },
  }

  await terminateWindowsProcessTree(ownership(1_300), operations)

  expect(terminated).toEqual([
    { pid: grandchild.pid, startedAt: grandchild.startedAt },
    { pid: child.pid, startedAt: child.startedAt },
  ])
  expect(remaining).toEqual([])
})

test("retains nested Windows ownership when an observed intermediate process exits", async () => {
  const child: WindowsProcessRecord = {
    pid: 200,
    parentPid: root.pid,
    startedAt: 1_100,
  }
  const grandchild: WindowsProcessRecord = {
    pid: 300,
    parentPid: child.pid,
    startedAt: 1_200,
  }
  const owned = ownership(1_300)
  let remaining = [child, grandchild]
  const terminated: WindowsProcessIdentity[] = []
  const operations: WindowsProcessTreeOperations = {
    async listProcesses() {
      return remaining
    },
    async terminateProcess(identity) {
      const process = remaining.find((entry) => entry.pid === identity.pid)
      if (!process) return "already-exited"
      if (process.startedAt !== identity.startedAt) return "identity-mismatch"
      terminated.push(identity)
      remaining = remaining.filter((entry) => entry.pid !== identity.pid)
      return "terminated"
    },
  }

  expect(await hasWindowsProcessDescendants(owned, operations)).toBe(true)
  remaining = [grandchild]
  expect(await hasWindowsProcessDescendants(owned, operations)).toBe(true)
  await terminateWindowsProcessTree(owned, operations)

  expect(terminated).toEqual([{ pid: grandchild.pid, startedAt: grandchild.startedAt }])
  expect(remaining).toEqual([])
})

test("does not kill a descendant PID whose identity changed after observation", async () => {
  const observed: WindowsProcessRecord = {
    pid: 200,
    parentPid: root.pid,
    startedAt: 1_100,
  }
  const reused: WindowsProcessRecord = { ...observed, startedAt: 1_250 }
  let terminationAttempts = 0
  const operations = treeOperations(
    [observed],
    async (identity) => {
      terminationAttempts++
      expect(identity).toEqual({ pid: observed.pid, startedAt: observed.startedAt })
      return "identity-mismatch"
    },
    () => [reused],
  )

  await expect(terminateWindowsProcessTree(ownership(1_300), operations)).rejects.toThrow(
    "no longer has its observed identity",
  )
  expect(terminationAttempts).toBe(0)
})

test("reports identity changes that race the Windows termination call", async () => {
  const survivor: WindowsProcessRecord = {
    pid: 200,
    parentPid: root.pid,
    startedAt: 1_100,
  }
  let terminationAttempts = 0
  const operations = treeOperations([survivor], async () => {
    terminationAttempts++
    return "identity-mismatch"
  })

  await expect(terminateWindowsProcessTree(ownership(1_300), operations)).rejects.toThrow(
    "identity changed before termination",
  )
  expect(terminationAttempts).toBe(1)
})

test("observes a rejected Windows identity query before delayed cleanup consumes it", async () => {
  const unhandled: unknown[] = []
  const recordUnhandled = (reason: unknown) => unhandled.push(reason)
  const identityFailure = new Error("Windows process identity query failed")
  let rejectIdentity!: (error: Error) => void
  const identity = new Promise<WindowsProcessIdentity | undefined>((_resolve, reject) => {
    rejectIdentity = reject
  })
  const owned = createWindowsProcessOwnership(root.pid, identity)
  const liveRoot: WindowsProcessRecord = { ...root, parentPid: 1 }
  let processQueries = 0
  const operations: WindowsProcessTreeOperations = {
    async listProcesses() {
      processQueries++
      return [liveRoot]
    },
    async terminateProcess() {
      return "terminated"
    },
  }

  process.on("unhandledRejection", recordUnhandled)
  try {
    rejectIdentity(identityFailure)
    await Bun.sleep(0)

    expect(unhandled).toEqual([])
    expect(owned.exitedAt).toBeUndefined()
    await expect(terminateWindowsProcessTree(owned, operations)).rejects.toBe(identityFailure)
    expect(processQueries).toBe(0)
  } finally {
    process.off("unhandledRejection", recordUnhandled)
  }
})

test("refuses to terminate a reused root PID", async () => {
  const reusedRoot: WindowsProcessRecord = {
    pid: root.pid,
    parentPid: 1,
    startedAt: 1_250,
  }
  let terminationAttempts = 0
  const operations = treeOperations([reusedRoot], async () => {
    terminationAttempts++
    return "terminated"
  })

  await expect(terminateWindowsProcessTree(ownership(1_300), operations)).rejects.toThrow(
    "no longer has its observed identity",
  )
  expect(terminationAttempts).toBe(0)
})

test("reports uncertainty when an owned Windows descendant cannot be confirmed terminated", async () => {
  const survivor: WindowsProcessRecord = {
    pid: 200,
    parentPid: root.pid,
    startedAt: 1_100,
  }
  const operations = treeOperations([survivor], async () => "uncertain")

  await expect(terminateWindowsProcessTree(ownership(1_300), operations)).rejects.toThrow(
    "termination could not be confirmed",
  )
})
