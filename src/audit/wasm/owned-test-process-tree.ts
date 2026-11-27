import type { OwnedTestProcessChild } from "./owned-test-process.ts"
import {
  createWindowsProcessOwnership,
  hasWindowsProcessDescendants,
  terminateWindowsProcessTree,
} from "./owned-test-process-windows.ts"
import type { WindowsProcessOwnership } from "./owned-test-process-windows.ts"

const PROCESS_TERM_GRACE_MS = 1_000
const PROCESS_KILL_WAIT_MS = 5_000
const windowsOwnershipByChild = new WeakMap<OwnedTestProcessChild, WindowsProcessOwnership>()

export function registerOwnedProcessTree(child: OwnedTestProcessChild): void {
  if (process.platform !== "win32") return
  const ownership = createWindowsProcessOwnership(child.pid)
  windowsOwnershipByChild.set(child, ownership)
  void child.exited.then(
    () => {
      ownership.exitedAt ??= Date.now()
    },
    () => {},
  )
}

function windowsOwnershipFor(child: OwnedTestProcessChild): WindowsProcessOwnership {
  let ownership = windowsOwnershipByChild.get(child)
  if (!ownership) {
    const created = createWindowsProcessOwnership(child.pid)
    windowsOwnershipByChild.set(child, created)
    void child.exited.then(
      () => {
        created.exitedAt ??= Date.now()
      },
      () => {},
    )
    ownership = created
  }
  return ownership
}

function processTargetExists(pid: number, processGroup = false): boolean {
  try {
    process.kill(processGroup ? -pid : pid, 0)
    return true
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

async function processTreeExists(pid: number, child?: OwnedTestProcessChild): Promise<boolean> {
  if (process.platform !== "win32") return processTargetExists(pid, true)
  if (!child) throw new Error("Windows process-tree observation requires an owned child")
  return hasWindowsProcessDescendants(windowsOwnershipFor(child))
}

export async function waitForProcessTreeExit(
  pid: number,
  timeoutMs: number,
  child?: OwnedTestProcessChild,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (await processTreeExists(pid, child)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(20)
  }
  return true
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processTargetExists(pid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(20)
  }
  return true
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code !== "ESRCH") throw error
  }
}

function signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code !== "ESRCH") throw error
  }
}

async function terminatePosixProcessGroup(pid: number): Promise<void> {
  signalProcessGroup(pid, "SIGTERM")
  if (!(await waitForProcessTreeExit(pid, PROCESS_TERM_GRACE_MS)))
    signalProcessGroup(pid, "SIGKILL")
}

async function terminatePosixProcess(pid: number): Promise<void> {
  signalProcess(pid, "SIGTERM")
  if (!(await waitForProcessExit(pid, PROCESS_TERM_GRACE_MS))) signalProcess(pid, "SIGKILL")
}

export async function terminateProcessTree(
  child: OwnedTestProcessChild,
  processGroup: "detached" | "inherited" = "detached",
): Promise<void> {
  if (process.platform === "win32") await terminateWindowsProcessTree(windowsOwnershipFor(child))
  else if (processGroup === "inherited") await terminatePosixProcess(child.pid)
  else await terminatePosixProcessGroup(child.pid)

  const processStopped =
    process.platform === "win32"
      ? await waitForProcessTreeExit(child.pid, PROCESS_KILL_WAIT_MS, child)
      : processGroup === "inherited"
        ? await waitForProcessExit(child.pid, PROCESS_KILL_WAIT_MS)
        : await waitForProcessTreeExit(child.pid, PROCESS_KILL_WAIT_MS)
  if (!processStopped)
    throw new Error(
      processGroup === "inherited" && process.platform !== "win32"
        ? "Owned test subprocess remained after termination"
        : "Owned test subprocess descendants remained after termination",
    )
}
