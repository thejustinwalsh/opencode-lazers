export interface WindowsProcessIdentity {
  pid: number
  startedAt: number
}

export interface WindowsProcessRecord extends WindowsProcessIdentity {
  parentPid: number
}

export interface WindowsProcessOwnership {
  pid: number
  identity: Promise<WindowsProcessIdentity | undefined>
  exitedAt?: number
}

export type WindowsProcessTermination =
  "terminated" | "already-exited" | "identity-mismatch" | "uncertain"

export interface WindowsProcessTreeOperations {
  listProcesses(): Promise<WindowsProcessRecord[]>
  terminateProcess(identity: WindowsProcessIdentity): Promise<WindowsProcessTermination>
}

const POWERSHELL = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
const PROCESS_QUERY_TIMEOUT_MS = 5_000
const PROCESS_TERMINATION_TIMEOUT_MS = 7_000
const PROCESS_TREE_TERMINATION_ROUNDS = 3

const listScript = [
  "$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {",
  "  [pscustomobject]@{",
  "    pid = [uint32]$_.ProcessId",
  "    parentPid = [uint32]$_.ParentProcessId",
  "    startedAt = [long]([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()",
  "  }",
  "})",
  "ConvertTo-Json -InputObject $processes -Compress",
].join("\n")

async function powershell(script: string, timeout: number): Promise<string> {
  const child = Bun.spawn([...POWERSHELL, script], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0)
    throw new Error(`Windows process operation failed: ${(stderr || stdout).trim()}`)
  return stdout.trim()
}

async function listWindowsProcesses(): Promise<WindowsProcessRecord[]> {
  const output = await powershell(listScript, PROCESS_QUERY_TIMEOUT_MS)
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    throw new Error(`Windows process observation returned invalid JSON: ${output}`, {
      cause: error,
    })
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null)
      throw new Error("Windows process observation returned an invalid entry")
    const { pid, parentPid, startedAt } = entry as Record<string, unknown>
    if (
      typeof pid !== "number" ||
      typeof parentPid !== "number" ||
      typeof startedAt !== "number" ||
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parentPid) ||
      !Number.isSafeInteger(startedAt)
    )
      throw new Error("Windows process observation returned an invalid identity")
    return { pid, parentPid, startedAt }
  })
}

async function terminateWindowsProcess(
  identity: WindowsProcessIdentity,
): Promise<WindowsProcessTermination> {
  const script = [
    `$targetID = [int]${identity.pid}`,
    `$expectedStart = [long]${identity.startedAt}`,
    "$target = $null",
    "try { $target = [System.Diagnostics.Process]::GetProcessById($targetID) }",
    "catch [System.ArgumentException] { ConvertTo-Json -Compress @{ result = 'already-exited' }; exit 0 }",
    "try {",
    "  $actualStart = ([DateTimeOffset]$target.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()",
    "  if ($actualStart -ne $expectedStart) { ConvertTo-Json -Compress @{ result = 'identity-mismatch' }; exit 0 }",
    "  $target.Kill()",
    "  if (-not $target.WaitForExit(5000)) { ConvertTo-Json -Compress @{ result = 'uncertain' }; exit 0 }",
    "  ConvertTo-Json -Compress @{ result = 'terminated' }",
    "} catch {",
    "  ConvertTo-Json -Compress @{ result = 'uncertain'; message = $_.Exception.Message }",
    "  exit 0",
    "} finally {",
    "  if ($target) { $target.Dispose() }",
    "}",
  ].join("\n")
  const output = await powershell(script, PROCESS_TERMINATION_TIMEOUT_MS)
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch (error) {
    throw new Error(`Windows process termination returned invalid JSON: ${output}`, {
      cause: error,
    })
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("result" in result) ||
    !["terminated", "already-exited", "identity-mismatch", "uncertain"].includes(
      String(result.result),
    )
  )
    throw new Error(`Windows process termination returned an invalid result: ${output}`)
  return result.result as WindowsProcessTermination
}

const nativeWindowsProcessTreeOperations: WindowsProcessTreeOperations = {
  listProcesses: listWindowsProcesses,
  terminateProcess: terminateWindowsProcess,
}

export function observeWindowsProcessIdentity(
  pid: number,
): Promise<WindowsProcessIdentity | undefined> {
  return listWindowsProcesses().then((processes) => {
    const process = processes.find((entry) => entry.pid === pid)
    return process ? { pid, startedAt: process.startedAt } : undefined
  })
}

export function createWindowsProcessOwnership(pid: number): WindowsProcessOwnership {
  return { pid, identity: observeWindowsProcessIdentity(pid) }
}

function descendantsOf(
  root: WindowsProcessIdentity,
  processes: readonly WindowsProcessRecord[],
  rootExitedAt: number | undefined,
  known: Map<number, WindowsProcessIdentity>,
): WindowsProcessIdentity[] {
  const byPID = new Map(processes.map((entry) => [entry.pid, entry]))
  const currentRoot = byPID.get(root.pid)
  if (currentRoot && currentRoot.startedAt !== root.startedAt)
    throw new Error(`Windows root PID ${root.pid} no longer has its observed identity`)
  if (!currentRoot && rootExitedAt === undefined)
    throw new Error(`Windows root PID ${root.pid} exited without an observed exit time`)

  const descendants = new Map<number, WindowsProcessIdentity>()
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (process.pid === root.pid) continue
      const parent = known.get(process.parentPid)
      if (!parent) continue
      const currentParent = byPID.get(parent.pid)
      if (currentParent && currentParent.startedAt !== parent.startedAt) continue
      const exitBoundary = currentParent || parent.pid !== root.pid ? undefined : rootExitedAt
      if (!currentParent && exitBoundary === undefined) continue
      if (process.startedAt < parent.startedAt) continue
      if (exitBoundary !== undefined && process.startedAt > exitBoundary) continue

      const existing = known.get(process.pid)
      if (existing && existing.startedAt !== process.startedAt) continue
      if (!existing) {
        const identity = { pid: process.pid, startedAt: process.startedAt }
        known.set(process.pid, identity)
        descendants.set(process.pid, identity)
        changed = true
      } else if (process.pid !== root.pid) {
        descendants.set(process.pid, existing)
      }
    }
  }
  return [...descendants.values()]
}

export async function hasWindowsProcessDescendants(
  ownership: WindowsProcessOwnership,
  operations: WindowsProcessTreeOperations = nativeWindowsProcessTreeOperations,
): Promise<boolean> {
  const root = await ownership.identity
  if (!root || root.pid !== ownership.pid)
    throw new Error(`Windows root PID ${ownership.pid} identity could not be observed`)
  const processes = await operations.listProcesses()
  const known = new Map([[root.pid, root]])
  return descendantsOf(root, processes, ownership.exitedAt, known).length > 0
}

export async function terminateWindowsProcessTree(
  ownership: WindowsProcessOwnership,
  operations: WindowsProcessTreeOperations = nativeWindowsProcessTreeOperations,
): Promise<void> {
  const root = await ownership.identity
  if (!root || root.pid !== ownership.pid)
    throw new Error(`Windows root PID ${ownership.pid} identity could not be observed`)

  let exitedAt = ownership.exitedAt
  const known = new Map<number, WindowsProcessIdentity>([[root.pid, root]])
  const initialProcesses = await operations.listProcesses()
  const initialRoot = initialProcesses.find((entry) => entry.pid === root.pid)
  if (initialRoot && initialRoot.startedAt !== root.startedAt)
    throw new Error(`Windows root PID ${root.pid} no longer has its observed identity`)
  const initialDescendants = descendantsOf(root, initialProcesses, exitedAt, known)

  if (initialRoot) {
    const result = await operations.terminateProcess(root)
    if (result === "identity-mismatch")
      throw new Error(`Windows root PID ${root.pid} identity changed before termination`)
    if (result === "uncertain")
      throw new Error(`Windows root PID ${root.pid} termination could not be confirmed`)
    exitedAt ??= Date.now()
    ownership.exitedAt ??= exitedAt
  } else if (exitedAt === undefined) {
    throw new Error(`Windows root PID ${root.pid} exited without an observed exit time`)
  }
  known.set(root.pid, root)

  let pending = initialDescendants
  for (let round = 0; round < PROCESS_TREE_TERMINATION_ROUNDS; round++) {
    const currentProcesses = await operations.listProcesses()
    const discovered = descendantsOf(root, currentProcesses, exitedAt, known)
    const targets = new Map([...pending, ...discovered].map((entry) => [entry.pid, entry]))
    for (const target of [...targets.values()].sort(
      (left, right) => right.startedAt - left.startedAt,
    )) {
      const result = await operations.terminateProcess(target)
      if (result === "identity-mismatch")
        throw new Error(`Windows descendant PID ${target.pid} identity changed before termination`)
      if (result === "uncertain")
        throw new Error(`Windows descendant PID ${target.pid} termination could not be confirmed`)
      if (result === "terminated" || result === "already-exited") {
        const identity = known.get(target.pid)
        if (identity) known.set(target.pid, identity)
      }
    }

    const remainingProcesses = await operations.listProcesses()
    const remainingRoot = remainingProcesses.find((entry) => entry.pid === root.pid)
    if (remainingRoot && remainingRoot.startedAt !== root.startedAt)
      throw new Error(`Windows root PID ${root.pid} identity changed during cleanup`)
    pending = descendantsOf(root, remainingProcesses, exitedAt, known)
    if (!remainingRoot && pending.length === 0) return
  }

  throw new Error("Windows process-tree termination could not be confirmed")
}
